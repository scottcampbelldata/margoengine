# Physics work queue

Who builds which of the 103 solvers in [physics-solvers.md](physics-solvers.md), so that two agents never build the
same one. Every solver is built on the framework in [physics-framework.md](physics-framework.md) and is judged
against the problems in [physics-demo-review.md](physics-demo-review.md). Read all three, and
[AGENTS.md](../AGENTS.md), before starting.

## How to claim a solver

1. Pick an **Open** row below, read its catalog row (methods, kernels) and every coupling-matrix row that names it.
2. Claim it before writing code: change its row here to Owner **Codex** and Status **BUILDING** with your branch
   name, commit only that change, rebase onto `origin/main` and push. If the push conflicts because the row changed,
   someone else claimed it: pick another.
3. Build it on your branch. Land it on `main` in working pieces (rebase, fast-forward, never force-push).
4. When it works with its tests, set Status **LANDED** with the commit, in the same push as the code.
5. **REOPENED** means an audit in [physics-solver-audit.md](physics-solver-audit.md) found a landed solver short of
   its catalog row or of the standard below. Codex builds every REOPENED row's upgrades, whoever built the row:
   the missing pieces and validation the audit names. It sets **LANDED** again with the new commit when the
   audit's list is done.
6. **VERIFIED** means a Claude reviewer has checked a LANDED row against the standard below and the audit's list:
   - it read the code and the tests;
   - it ran the row's tests;
   - it confirmed each validation test asserts against the cited measurement or exact solution.

   A row that fails verification goes back to **REOPENED**, with the reasons added to its audit entry. A row is
   finished only when it is VERIFIED.

Never take or edit a row owned by someone else. Claim one solver at a time per working session.

## What every solver must do

- Implement the `Solver` contract in `packages/physics/src/world/solver.ts` (describe, init, step, exportPorts,
  importPorts, stateRegions, extraState), register its fields through the field registry
  (`packages/physics/src/world/fields.ts`), and step on the world clock at a dyadic rate (`60 * 2^k` Hz).
- Use `@margoengine/math/pinned` for exp, ln, sin, cos, pow and hypot in anything that feeds state, never host
  `Math` transcendentals or `**` (`npm run check:pinned-math` refuses them). Never hold a typed-array view across an
  allocation or a step.
- Read other solvers only through fields and the contract types in `@margoengine/math/fields`; where the field you
  need is not on `main` yet, build against its contract type with a test stand-in.
- Pass the coupling harness (`packages/physics/tests/coupling/`); `npm run check:coupling` refuses a framework solver
  that no coupling test runs.
- Research first: read the papers the catalog row cites (verify each), cite them in `docs/clean-room.md`, and never
  read other engines' source code.
- Tests: closed-form or measured checks with derived bounds, a determinism test (the same state hash twice, and after
  a snapshot and restore), and for every demo-review row the solver fixes, a test that reproduces that row's
  failure. No loosened bounds and no hard caps written up as limits. Constants that published sources leave
  uncertain may be calibrated against measured data, validated on data not used for the fit, and recorded (source,
  method, value, uncertainty, validation); never tuned until a failing test passes.
- CPU-heavy loops go in a Rust crate compiled to Wasm with SIMD (one crate per family, loaded lazily by its optional
  entry). The public API stays TypeScript. Core and stage gain zero bytes.
- Docs in the same push: a README example that runs, the clean-room record, `docs/limits.md`, `docs/known-bugs.md`,
  and `npm run api:update` for new exports. Gate before every push as AGENTS.md describes (never `npm run verify`).

### The standard: the best solver we can build (Scott, 2026-11-26)

Scott: "I want every solver built to be the best most powerful we are capable of producing." Meeting the catalog row
is the floor, not the goal. A solver is finished only when all of these hold:

1. **The strongest model.** The most accurate published model that can run at film scale, from a wide search of
   current literature (not the first textbook model). Where fidelity and cost trade off, ship both tiers behind one
   API: a high-fidelity tier and a fast tier, each validated, chosen by an option with a documented default.
2. **Validated against the real world.** Several published measurements or exact solutions across the regimes the
   films use (calm to extreme), each with its source and a derived bound, including cases not used for calibration.
3. **Broader than any rival.** At least every capability of the best engines and specialised libraries for that
   phenomenon (web 3D engines, Rapier, and the leading specialised libraries and research codes), and better where
   possible. A capability another tool has and this solver lacks is a gap to build.
4. **Fully coupled.** Two-way coupling with every neighbour the catalog names, through fields, with a coupling test
   for each, and conserved quantities (mass, momentum, energy) accounted across the coupling.
5. **Robust at the extremes.** No NaN, no energy gain and no blow-up across the documented range, including storms,
   high speeds, large mass ratios, tiny and huge scales and long runs. Inputs outside the range are refused with a
   coded error that names the fix.
6. **Scales.** Hot loops in Rust and Wasm with SIMD, threads where the work splits, and large worlds through cells
   and floating origin, with work counts recorded.
7. **Directable for film.** Controls a director needs (seeds, placed events, targets, look parameters) that steer
   the result without breaking the physics, and output the renderer draws directly.
8. **Honest.** `docs/limits.md` states what it does not do; nothing is called finished while a known piece is missing.

A solver landed before this standard keeps its row and is re-audited against it (`docs/physics-solver-audit.md`).
One that falls short goes back to its owner as REOPENED, with the missing pieces named. Solvers that block a film in
production come first; upgrade passes follow, solver by solver.

## Framework requests

The framework (`packages/physics/src/world/`, `packages/kernel-common/`, `@margoengine/math/fields`,
`@margoengine/math/pinned`, `@margoengine/math/clock`) changes only through its owners. If a solver needs a change
there, add a line below with the solver ID and what is needed, and build against what exists meanwhile.

- **FLUID-01:** Connect SEA-04 and general HYDRO-01 cells to the optional DFSPH layout-1 parcel requests and
  receipts. The real HYDRO-01 wet-cell test settles signed depth and both horizontal momentum components in
  the same tick through the signed inflow and added forcing. Vertical momentum stays in a separate ledger.
  General shoreline coupling needs HYDRO-01 to reserve donor volume and report what signed volume and
  momentum the wet/dry update actually accepts. SEA-04 needs a paired debit and horizontal momentum
  receipt at the solver boundary. DFSPH now publishes current hard-contact position, time, normal impulse
  and dissipated energy through its optional impact field. SOUND-05 needs a consumer for that field and an
  entrained-bubble event contract. SOUND-04's modal contact field has a real impact producer.

- **SOFT-04** needs a same-tick handoff for GPU-resident positions and reciprocal rigid-contact impulses,
  with an ordered snapshot readback after the tick commits. The current SoftSolver contract steps CPU
  regions synchronously. Both native nonlinear modes run on that contract and use the existing rigid fields.

- **EARTH-05:** Promote patch geometry, normal load, shear displacement and response to common terrain-contact layouts.
  Expose shared per-vertex solid material and accepted excavation so terrain, soil and erosion can exchange changing
  properties in the same step. The optional entry accepts the same bedrock inputs as TerrainBed, samples hardpan
  thickness locally, uses `bedChange` and publishes versioned contact response and ATMO-06 dust.

- **SEA-15:** Return accepted per-contributor vertex erosion from `bedChange` when several sediment writers share
  a bedrock-limited grid. The tracer currently budgets a finite mobile layer for its single sediment
  writer and returns suspended mass to the live `TerrainBed` on contact.

- **ATMO-10:** Publish the SEA-07 adapter's regional pressure and wind input layout, including origin and
  spacing. The synoptic solver supplies pressure and horizontal wind on its local grid and already transfers
  their gradient and stress through the shallow-water forcing port.

- **EARTH-10:** Specify a registered extent and per-source basal heat acceptance on ICE-01 columns, plus a shared
  solid-deposit height/material input for EARTH-02. The existing lava entry publishes grid height and lava records,
  exchanges heat and phases with ICE-05, and emits registered layout-1 coastal displacement.

- **DYN-04:** Define canonical wheel sinkage/soil displacement and road-control fields for EARTH-05 and procedural
  traffic publishers. The road entry already reads real rigid body poses and ATMO-09 wetness, publishes versioned
  drive commands, and applies paired contact impulses through the existing vehicle attachment.

- **SPACE-03:** Register shared annulus geometry and radial density, heating and phase contracts for science
  visualizations and Event Horizon. The solver publishes layout-1 fields in documented radial order.

- **SOFT-06:** Add versioned per-chamber pressure and volume fields to the soft framework entry for atmospheric pressure
  input and gas feedback. The native soft constraint already uses the rigid contact fields and snapshots the fill.

- **SOUND-02:** Add a shared scene occupancy, surface material and impedance layout for evolving EARTH-02 terrain.
  The room entry accepts explicit air masks and finite convex reflection faces. Its layout-1 registry fields carry
  pressure excitation and receiver samples in Pa with the configured grid and sample clock.

- **BIO-02:** Promote branch topology and geometry rows to a shared growth contract, and expose an obstacle field
  and cell extent contract for moving scene geometry. The optional entry publishes a versioned geometry graph, reads
  the live HYDRO-02 field, and runs its slot-free occupancy test in both memory modes.

- **ATMO-06:** Promote the environmental source flux and deposited/vapour mass fields for EARTH-05 footstep dust
  and air/soil feedback. Publish source-grid geometry where types currently describe only rows. The airborne
  entry reads the existing EARTH-07 dust and SEA-13 whitecap fields on matching geometry and exposes the scoped ports.

- **BREAK-03:** SEA-10 needs a versioned compartment opening and resulting carried water mass and inertia. The
  current crush entry publishes calibrated seal loss and posts matched normal and angular impulses through the
  rigid ports. A contact effective-inertia port would share resolved fluid added mass during shorter crush events.

- **BIO-03:** Register canonical x-fast cell fields for forest burn severity, fuel moisture, live canopy fuel,
  crown cover and root cohesion, and expose producer extents with their grid ports. The optional forest solver
  ships its versioned exposure and output fields and consumes HYDRO-01 and HYDRO-04 directly on matching grids.

- **LIFE-01:** Publish common legged intent/load/pose/stance descriptors and moving support geometry with a
  per-contact surface velocity. The optional module reads `bodies` and posts `bodyImpulses` for an explicit rigid
  rectangular deck. DYN-07 articulation, LIFE-06 rider forces and SEA-12 immersion can consume the versioned
  legged fields until their shared contracts are available. Reuses slot 13.

- **LIFE-02:** Reserve static Wasm slot 13 and promote the versioned `groundAnimalPose` and
  `groundAnimalContact` rows to shared fields when the rigid/animation readers adopt them. Add initial cell and
  cell size to the solver host, portable bed geometry, and a contact-wrench accumulator for articulated bodies
  and ground wear. The optional entry uses the live `bed` field with configured geometry, publishes both
  versioned ports, and accepts an explicit initial cell meanwhile.

- **EARTH-07:** Define the canonical boundary-layer momentum sink and dust inflow grid for ATMO-01 and ATMO-06.
  The optional entry already emits vertex-centred layout-1 horizontal stress in Pa and dust in kg/(m² s).
  It consumes the `Wind` contract or held friction fields. Registry fixtures exercise the outgoing ports
  while the atmosphere solvers adopt those fields.

- **BIO-04:** Provide a canonical per-patch material exposure layout for annual climate, deposition,
  immersion, corrosion current and larval availability. The ageing entry consumes a versioned
  exposure port with the same units and tests it with a replayable publisher.

- **LIFE-05:** Register slot 10 for the pedestrian SIMD kernel. Provide canonical per-body force
  and stance/position fields and an identity layout for LIFE-06 formations, DYN-07 body and foot
  hand-off, and BREAK-05 impacts. LIFE-05 publishes its declared kinematics and compressive loads
  and reads versioned intent and force ports in the optional package until the shared fields are ready.

- **SOUND-04:** Publish full-step rigid point impulses with substep timing, tangential slip and rolling
  kinematics. A canonical fracture-energy or fragment impulse field would let BREAK-01 drive the same
  acoustic tracks. The optional rigid adapter uses existing impulse totals, final manifolds and joint
  ruptures meanwhile. Its versioned contact and fracture descriptors also accept external producers.
  Register the modal audio kernel in module slot 11 when the framework module table adds production entries.

- **LIFE-03:** Register swim kernel slot 5 in the module table alongside the other production families.
  Promote the school's kinematics and intent layouts when the shared fields owner is ready. The swimmer
  also needs shared world-space contact wrench and per-actuator water impulse layouts for articulated
  proxies, SEA-12 wakes and SEA-15 sediment. The optional LIFE-03 entry owns those descriptors until the
  shared contracts are available, and its fixtures exercise both data paths.

- FIRE-06 needs sharable temperature-grid metadata and the framework's K12 sparse linear solver for very stiff heat grids. The optional thermal entry provides backward Euler using a matrix-free stationary solve. Its solid solver reads the temperature and optional phase port using explicitly supplied matching geometry.
- **LIFE-04 / LIFE-03 / AERO-03:** Move the versioned `schoolIntent` and `schoolKinematics` descriptors and f64 row
  layouts into `@margoengine/math/fields` once the owning body solvers adopt the ports. A shared `SolverHost.cellSize`
  would also let port and flow readers convert cells without duplicating `world.cellSize` in their parameters. LIFE-04
  ships the optional entry's descriptors and explicit cell size in the interim. The school kernel uses static window slot 4.
  A caller-owned neighbour-grid workspace in K06 would let the kernel import only the world's memory.

- **BIO-01.** Publish subsurface orbital velocity, density and temperature as a replayable `FlowField`. Expose the
  world's cell size through `SolverHost` so fluid consumers can translate between origin cells. Publish the rigid
  normal impulses across the full step with contact points in a field shared by all solvers. Reserve field-accumulator
  sum regions at setup, so a time-zero snapshot made before the first sum can restore after the world has stepped.

- RESOLVED (2026-11-25, see the commit that adds this note): The framework owners are needed for the API diagnostic quality gate for FIRE-06. On public main c62096b0a4, the API gate reports 12 missing repair instructions in `packages/physics/src/world/scheduler.ts`, one in `snapshot.ts`, and two in `world.ts`. Please give callers an actionable remedy for invalid accelerator and rate options, a corrupt snapshot, and incomplete implicit-pressure coupling declarations. The protected framework paths remain owner-managed.
  Every framework throw in `scheduler.ts`, `snapshot.ts` and `world.ts` now names its fix.

- RESOLVED. The former 15,475 B gzip limit blocked FIRE-06 after the diagnostic fix.
  The framework owner updated the world entry's limit to 16,490 B when the shared module layout landed
  in d0a3529504. FIRE-06 with the plain and shared thermal builds measures 16,470 B for the world entry.

- FIRE-06 uses module slot 2 for the plain and shared thermal builds. Please reserve this in the central
  module table when production solvers join it.

- SPACE-02 requests shared contracts in @margoengine/math/fields for tidalPotential (m²/s² with Earth-fixed gradient
  in m/s² at a Cartesian point) and insolation (W/m² and solar direction at a WGS 84 site) for SEA-07 and ATMO-09.
  The celestial solver publishes both as layout-1 registry ports and supplies readers and test stand-ins.

- ICE-05 requests canonical layout-1 fields for ice boundary heat (W/m²), temperature (K), vapour (Pa),
  drainage and steam (kg/s), and absorbed heat (W). ICE-05 publishes its current layouts through
  `@margoengine/physics/ice`. A staggered test uses the same layout for EARTH-10 forcing and feedback.

- **AERO-05.** Reserve static module slot 7. Expose a canonical swept-shape boundary query with
  moving-surface velocity and corresponding rigid impulse points. Expose the world's cell size through
  SolverHost. The falling entry uses a pure, fixed-scene swept-sphere adapter and an explicit cell size.

- SPACE-01 reserves module window 8 for the plain and shared orbit kernels. Add the slot to the central table
  when production solver windows join it. The optional orbit entry publishes inertial positions and velocities
  as f64 xyz rows and elapsed time as a scalar in its layout-1 registry fields.

- **ICE-02:** Reserve static module window 14. Add shared layout-1 f64 glacier outlet discharge (m³/s) and
  per-tick marine and dry ice-release volumes (m³) for HYDRO-02 and SEA-06. ICE-02 publishes these descriptors
  in the optional glacier entry, couples discharge to HYDRO-01 and exercises a wave-source reader.

- **ICE-03:** Promote layout-1 f64 SeaSource patch rows and marine release-volume fields into the shared contracts.
  The optional Physics entries use the existing contract type, match ICE-02 and the wake through declared ports, and
  use no static module window. A canonical per-body contact impulse port would support iceberg grounding and ship contact.

## Research notes for open solvers

Earlier design work on some open solvers, to start from. Formulas are as the designers wrote them; check each against its paper before relying on it, and cite what you use.

### LIFE-03 swimming and LIFE-04 schools (design, no code)

- **Swim solver:** `SwimSolver` implements `Solver` in a new entry, `@margoengine/physics/life`.
  - Each fish is a 6-DOF body with diagonal added mass (Lamb; strip theory), Kirchhoff terms (Fossen) and
    Froude-Krylov forces from the water FlowField (Morison).
  - Friction follows ITTC-57 with a Prandtl-Schlichting laminar blend, plus cross-flow strip drag.
- **Thrust:** Lighthill's cycle-mean `T = (m/4) a² ω² (1 - (U/c)²)`, with `m = π ρ s² / 4` at the tail span `s`.
  - Efficiency is `½ (1 + U/c)`, so speed emerges from the tail beat rather than being set.
  - Test the Strouhal number against 0.2 to 0.4.
  - Effort sets the beat frequency, and the clip's phase is the integrated beat.
- **Turning:** fin lift gives a lateral force and a yaw moment, `½ ρ CLmax A (u² + v_fin²)`.
  - Minimum turning radius is about `2 (m + m_a) / (ρ CL S_lat)`.
  - Bank angle comes from `tan φ = heel moment / (W GM)`.
- **Hovering:** drag-based pectoral sculling (Blake 1979), with fin force `½ ρ CD A (a ω)²`.
  - Yaw rate stays finite against rotational strip drag, `ρ CD h L⁴ ω |ω| / 64`.
- **Integration:** linearly implicit for drag, with `stableRate()` derived from `|ω| dt`.
  - Pinned math only, no atan2 (use half-angle square roots).
  - Follow targets come from an interpolated `targets(frame, part)`.
- **Schools (LIFE-04):** a separate solver writes a swim-intent field that the swimmers read.
  - Topological neighbours (Ballerini et al. 2008), plus a predator-avoidance rule.
  - Mass and turn limits come from the swim solver.
- **Sources checked:** Lighthill 1971 (Proc R Soc B 179:125-138), Blake 1979 (J Exp Biol 82:255-271).
- **Sources still to check:** Weihs 2002 (Integr Comp Biol 42:127-134), Lighthill 1960, Bainbridge 1958, Taylor,
  Nudds and Thomas 2003, Fossen 2011, Lamb 1932, Hoerner 1965, Morison et al. 1950, Domenici and Blake 1997.

### FLUID-01 and FLUID-02 particle liquids (design, no solver code)

- **DFSPH (Bender and Koschier 2015):**
  - The density factor is `α_i = ρ_i / (|Σ m_j ∇W|² + Σ |m_j ∇W|²)`, with the denominator floored.
  - Pressure stiffness is `κ_i = (ρ* - ρ0) α_i / dt²` for density and `κ_v = (Dρ/Dt) α_i / dt` for divergence.
  - Jacobi iterations with a warm start.
  - The CFL time step is `dt <= 0.4 d / v_max`, and negative pressure is clamped.
  - Tolerances are 0.01% on density and 0.1% on divergence.
  - Step order: forces, density solve, positions, grid rebuild, divergence solve.
- **Rigid boundaries (Akinci et al. 2012):**
  - Boundary volume `V_b = 1 / Σ W_bk` and `Ψ_b = ρ0 V_b`, so density is `m Σ W + Σ Ψ_b W`.
  - The boundary pressure force uses the fluid particle's `p / ρ²`, equal and opposite on the body, with force and
    torque about the centre of mass.
  - Friction comes through artificial viscosity.
- **Surface tension and adhesion (Akinci et al. 2013):**
  - Cohesion kernel `C(r)` with its `32 / (π h⁹)` piecewise form.
  - Curvature term `-γ m (n_i - n_j)`, with the symmetric factor `K_ij = 2 ρ0 / (ρ_i + ρ_j)`.
  - Adhesion kernel `A(r) = 0.007 / h^3.25 (-4r²/h + 6r - 2h)^(1/4)` for `h/2 < r <= h`.
- **Layout:**
  - One Rust crate; state columns are x, v, κ and κ_v.
  - Density, α and the grid are derived and rebuilt each step.
  - Boundary force and torque held over a step go into the `bodyForces` accumulator, and instantaneous impulses into `bodyImpulses`, both owned by `RigidSolver` (`packages/physics/src/world/solvers/rigid.ts`).
- **Not yet read:** Bender and Koschier 2017 on implicit viscosity, Zhu and Bridson 2005, Jiang et al. 2015 (APIC),
  and Fedkiw, Stam and Jensen 2001 on smoke.
- **The shared neighbour grid already has a sparse mode** for large domains (sorted 63-bit cell keys, the same
  candidates in the same order as the dense grid).

### BIO-01 plant sway in wind and water (design, no code)

- **Entry and model:** `@margoengine/physics/vegetation`, class `PlantSway implements Solver`.
  - Each plant is a tapered, possibly hollow cantilever, described by E, density, base and tip diameters, wall
    ratio, crown mass, area and start height, Cd, modulus of rupture and anchorage strength.
- **Modes:** a Ritz basis of the first two uniform clamped-free modes.
  - β comes from `cos β cosh β = -1` by bisection, using pinned exp, sin and cos.
  - Solved as a 2x2 generalized eigenproblem, so frequencies come from the geometry and none are fitted.
- **Loads:** Morison's equation at 3-point Gauss-Legendre nodes on the stem and on the crown.
  - Drag is `½ ρ Cd A |u_rel| u_rel` on the transverse relative velocity, so aerodynamic damping comes automatically.
  - Inertia is `ρ (1 + Ca) V du/dt`, with `du/dt` from two FlowField samples, and added mass goes in the mass matrix.
  - Density comes from the FlowField sample, so one solver serves air and water.
  - Vogel reconfiguration scales drag by `(U/U_v)^V` above `U_v = sqrt(EI_eq / (ρ A H²))`, where the Cauchy number
    is 1.
- **Time stepping:** linearised-drag implicit midpoint (A-stable, a 2x2 solve per axis, deterministic).
  - Gusts travel as visible fronts because each plant samples the FlowField at its own position and time.
- **Failure:** base moment `M = EI u'' / H²` from the modes, and stress `M / Z` at 8 stem stations.
  - The stem snaps at σ >= the modulus of rupture (break height recorded), and the plant uproots at M >= the
    anchorage strength (Peltola et al. 1999).
- **Output port `plantSway`:** per-plant modal tip amplitudes, peak load ratio and status.
  - Wiring it into scatter and the tree shaders needs a deflection grid or texture read in the wind shaders, which
    is the larger job.
  - Kelp and anemones add buoyancy as a restoring term in the same solver.
- **Fields:** `wind` (air) and `current` (water), each as uniformGrid, velocity, m/s, cell-centred.
- **Sources checked against the publishers' pages:**
  - de Langre 2008 (Annu Rev Fluid Mech 40:141-168);
  - Py, de Langre and Moulia 2006 (JFM 568:425-449);
  - Gosselin, de Langre and Machado-Almeida 2010 (JFM 650:319-341);
  - Vogel 1989 (J Exp Bot 40:941-948);
  - Peltola et al. 1999 (Can J For Res 29:647-661);
  - Gardiner, Peltola and Kellomäki 2000 (Ecol Model 129:1-23);
  - Stam 1997 (CGF 16(3));
  - Habel, Kusternig and Wimmer 2009 (CGF 28(2):523-532).
- **Still to check:** Blevins' cantilever mode constants, Morison et al. 1950, and Raupach, Finnigan and Brunet 1996.

### The terrain bed field, PA-37 (LANDED; for the EARTH and HYDRO solvers that build on it)

- **Contract:** `bed.ts`, types only, in `@margoengine/math/fields`.
  - `TerrainBed` owns the field `bed`, a vertex grid in the rigid kernel's height-field layout, kept in f64 and
    published as f32.
- **Writers:** erosion, slides and craters add metres of change to the accumulator field `bedChange`.
  - The bed applies the sum each tick, clamps at an optional bedrock, and keeps a ledger of requested and refused
    volume.
  - `bedVertexAreas` is exact for the kernel's triangulation, so contributors can conserve mass.
- **Readers:** `BedSurface` and `bedFromPort` sample elevation and normal on the kernel's own triangles.
- **Collider:** `BedCollider`, a fixed body holding the kernel's height field, edited in place through
  `PhysicsCollider.setHeights` (the kernel's `refit_grid`): editing the ground every step allocates nothing.

## Who builds what (Scott, 2026-11-26)

- Codex builds every row in the Open table below, plus the rows it has claimed.
- Claude builds the rows in the Taken table.
- Solvers for films in production come first.
- When both lists are built, all 103 solvers are audited against "The standard: the best solver we can build" above
  (`docs/physics-solver-audit.md`). Every row that falls short is REOPENED with its upgrades named, and stays open
  until it is the best on the market.
- Handed to Codex (Scott, 2026-11-26), so the Claude side stays on the film solvers: DYN-07, AERO-01 to AERO-03
  and ATMO-01 to ATMO-03. The AERO and ATMO rows are built and REOPENED; build their upgrades from
  `docs/physics-solver-audit.md`.
- Parity (Scott, 2026-11-26: "I want 100% parity"): every PARTIAL or MISSING row in `docs/rapier-parity.md`,
  `docs/rapier-parity-2d.md` and `docs/physics-collision-parity.md` is finished to DONE by the owner its Owner column
  names. Rows with no solver are assigned here:
  - 2D soft bodies (S2-01 to S2-12, SB-03, and the 2D parts of SB-01, SB-12 and SB-17): Claude, with SOFT-02.
  - X-60 unified particles: Codex, with FLUID-01 and FLUID-02.
  - X-81 rollback and X-82 snapshot sync: Claude, with DYN-03.
  - X-84 record-and-replay debugger, X-85 per-island profiler, X-86 binary shape cache: Claude, with DYN-01.
- Upgrades (Scott, 2026-11-26): Codex builds every upgrade, on every REOPENED row, whoever first built it. Claude
  finishes the builds it still has CLAIMED, then verifies: each row Codex sets LANDED is checked and set VERIFIED,
  or REOPENED with reasons.

## Open

| ID | Solver | State today | Owner | Status |
| --- | --- | --- | --- | --- |
| DYN-08 | Large-scale GPU rigid dynamics | none | Open | OPEN |
| SOFT-04 | Volumetric solids (FEM) | native FEM, Projective Dynamics and finite-chain rubber with reciprocal contact, cutting and fracture | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed a0de32ed1b |
| SOFT-06 | Pressure bodies | physics/soft with sealed gas and rigid contact | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed a82ff99eb9 |
| BREAK-04 | Exterior ballistics | partial | Open | OPEN |
| BREAK-05 | Terminal ballistics and impact damage | stand-in | Open | OPEN |
| LIFE-02 | Limbless, insect and small-animal locomotion | physics/locomotion with TerrainBed and stance wrenches | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 6712e2b2a4 |
| LIFE-07 | Machine dynamics with actuators | stand-in | Open | OPEN |
| AERO-04 | Turbomachines in flow | none | Open | OPEN |
| AERO-05 | Falling and tumbling light bodies | falling plates, winged seeds and swept hail | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed c82d68bf98 |
| SEA-03 | Nonlinear waves, rogue waves | none | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 47be5f699 |
| SEA-06 | Tsunami and impulse waves | none | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 1905b1c216 |
| SEA-07 | Tides, storm surge and currents | none | Claude | CLAIMED |
| FLUID-05 | Compressible flow, shock and blast | none | Open | OPEN |
| FLUID-06 | Viscoplastic fluids at small scale | partial | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed a540dd915c |
| FLUID-07 | Thin films and droplets on surfaces | stand-in | Codex | BUILDING (codex/physics-thin-film-upgrade) |
| HYDRO-02 | Rainfall-runoff and infiltration | soil wetting, watershed hydrographs and flood coupling | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 9f6f7e9004 |
| HYDRO-04 | Landscape evolution | implicit incision, soil transfer and physical Biomes relief | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed dc75a47d35 |
| HYDRO-05 | Dam and levee breach | stand-in | Open | OPEN |
| HYDRO-06 | Groundwater and springs | Darcy flow, aquifer recharge and spring discharge | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed b6e01ceb4c |
| ATMO-05 | Tropical cyclones and large vortices | physics/vortices and Sky | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 80aa218baa |
| ATMO-06 | Airborne particle transport | stand-in | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 965fab2df7 |
| ATMO-07 | Lightning and atmospheric electricity | none | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 51ccc096bc |
| ATMO-08 | Fog and cold-air drainage | physics/drainage-fog and environment/fog-volumes | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 80679b25b4 |
| ATMO-09 | Surface energy balance | surface temperature, liquid and snow budgets, wetness and fuel | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 93bf3f2435 |
| EARTH-03 | Particle-laden gravity currents | partial | Open | OPEN |
| EARTH-05 | Terramechanics | physics/terramechanics with native soil, live rigid and legged contacts, and mineral dust | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), upgrade parts c99bb12d2a and 0fa769d6dc |
| EARTH-06 | Impact and explosion cratering | stand-in | Open | OPEN |
| EARTH-07 | Aeolian transport | physics/aeolian | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed d2fa3cb303 |
| EARTH-08 | Seismic waves and ground shaking | physics/seismic | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 32c933e9d0 |
| EARTH-09 | Volcanic eruption column | partial | Open | OPEN |
| EARTH-10 | Lava flow | partial | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 3a35fac405 |
| ICE-01 | Snowpack | physics/snowpack and weather/avalanche | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 7f5ad4a8d2 |
| ICE-02 | Glacier and ice-sheet flow | physics/glacier | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 096242cb21 |
| ICE-03 | Iceberg rigid-body dynamics and calving | physics/iceberg | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 7dbf9e06ee |
| ICE-04 | Pack ice and floes | stand-in | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed dbc7a0efd9 |
| ICE-05 | Ice thermodynamics | physics/ice | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 7b64dddf4f |
| FIRE-04 | Explosive blast loading | none | Open | OPEN |
| FIRE-05 | Explosive source and fragments | stand-in | Open | OPEN |
| FIRE-06 | Heat conduction and phase change | heat, phase change and thermoelasticity | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed e497def90e |
| FIRE-07 | Burning of structures, ships and solids | stand-in | Open | OPEN |
| SOUND-01 | Outdoor propagation | physics/outdoor-sound and audio/outdoor | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 976796766b |
| SOUND-02 | Enclosed and urban acoustics | physics/room-sound | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed bb16680105 |
| SOUND-03 | Underwater acoustics | physics/underwater | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 9f850999d0 |
| SOUND-04 | Contact and modal sound | none | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed e0b1f274ab |
| SOUND-05 | Physics-driven fluid, fire, wind and machine sound | none | Open | OPEN |
| BIO-02 | Plant growth and morphogenesis | biomes/growth with HYDRO-02 soil and live Procedural branch graphs | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed d5e70fde20 |
| BIO-03 | Forest ecosystem dynamics | sound | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 609d76e5ce |
| BIO-04 | Material ageing | material exposure, decay and PBR appearance | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 9632f2731c |
| SPACE-01 | N-body and orbital dynamics | physics/orbit | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 56f09d5d54 |
| SPACE-02 | Celestial ephemeris and rotation | partial | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 18dbe0de5e |
| SPACE-03 | Accretion disks and motion near compact objects | physics/accretion with viscous transport and geodesics | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 0c11fd27f7 |
| DYN-04 | Wheeled vehicles on roads | partial | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 18ded2be7c |
| DYN-05 | Rail vehicle dynamics | none | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed fa79b04868 |
| SOFT-03 | Hair, fur, mane, tail, feathers, spring bones | native rods, fast guides and physical skin bindings | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed c53e60dc12 |
| SOFT-05 | Muscle, fat and skin soft tissue | physics/tissue with skeletal pins, sliding planes and passive layers | Open | OPEN |
| BREAK-01 | Brittle and ductile fracture, destruction | stand-in | Open | OPEN |
| BREAK-02 | Structural collapse and load path | stand-in | Open | OPEN |
| BREAK-03 | Ductile crushing: hulls, car bodies, rail cars | physics/crush with permanent work, rigid recoil and seal loss | Codex | BUILDING (codex/physics-crush-film) |
| LIFE-01 | Legged animal locomotion (quadrupeds, bipeds) | physics/legged with live terrain and rigid decks and Horses gait drive | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 64bedcf038 |
| LIFE-03 | Aquatic locomotion | physics/life | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 708e96a06b |
| LIFE-04 | Collective animal motion | deterministic schooling, physical steering and intent ports | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 006faf6368 |
| LIFE-05 | Pedestrian and dense-crowd dynamics | physics/pedestrians and mass-weighted NavMesh avoidance | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 561885e7a1 |
| LIFE-06 | Mass formations and cavalry charge | stand-in | Open | OPEN |
| FLUID-01 | SPH, divergence-free (accurate mode) | none | Open | OPEN |
| FLUID-02 | Position based fluids (fast mode) | none | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 14a5956173 |
| FLUID-04 | Eulerian smoke and gas | stand-in | Open | OPEN |
| HYDRO-03 | Sediment transport and channel morphodynamics | stand-in | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed db1950c88f |
| ATMO-10 | Synoptic weather and moisture transport | stand-in | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed d19267aa1e |
| EARTH-01 | MPM continuum | stand-in | Open | OPEN |
| EARTH-02 | Depth-averaged granular flow | partial | Open | OPEN |
| EARTH-04 | Discrete-element rubble and boulders | partial | Open | OPEN |
| FIRE-01 | Wildfire spread | partial | Open | OPEN |
| FIRE-02 | Flame and fireball | stand-in | Open | OPEN |
| FIRE-03 | Integral plume and thermal model | partial | Open | OPEN |
| BIO-01 | Plant mechanics under wind and water | modal sway, windthrow and rigid impacts | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed a4d123a968 |
| DYN-07 | Dynamic character, balance, push response | partial | Codex | OPEN |
| AERO-01 | Aerodynamic loads on bodies | stand-in | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 48b593a13 |
| AERO-02 | Membrane aerodynamics (FSI) | none | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 2f1860412 |
| AERO-03 | Flight dynamics (wings, rotors, bodies) | none | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed f9161cc7e |
| ATMO-01 | Boundary-layer wind field | stand-in | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed c38c25d3d |
| ATMO-02 | Atmospheric turbulence and gusts | stand-in | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed c38c25d3d |
| ATMO-03 | Moist convection and cloud dynamics | none | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 8833dbf0c |

## Taken

Claimed by Claude: the framework's foundation, the ship at sea (hull, ocean, wakes, spray, wind, rain) and the rigid core. Do not start these.

| ID | Solver | State today | Owner | Status |
| --- | --- | --- | --- | --- |
| SEA-05 | Nearshore waves and surf zone | partial | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 8c7453cd8 |
| DYN-01 | 3D rigid body and contact | sound | Claude | CLAIMED |
| DYN-02 | 2D rigid body | sound | Claude | CLAIMED |
| DYN-03 | Articulated bodies, joints, motors, robots | partial | Claude | CLAIMED |
| DYN-06 | Mass properties and collision geometry | partial | Claude | CLAIMED |
| SOFT-01 | Cloth and thin shells | partial: water as a medium landed 1b7d95a48, curtains in a moving hull 3d1e785d7 | Claude | CLAIMED |
| SOFT-02 | Rods, ropes, cables, chains (Cosserat) | partial | Claude | CLAIMED |
| SEA-01 | Wave spectrum and wave-field evolution | stand-in | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 62fa8c303 |
| SEA-02 | Ocean surface synthesis and query | partial | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 52b68ca65 |
| SEA-04 | Local dispersive free surface | stand-in | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 33ab69766 |
| SEA-08 | Ship seakeeping | stand-in | Codex | BUILDING (codex/physics-seakeeping-speed) |
| SEA-09 | Manoeuvring, propulsion, resistance, sailing hull | none | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed ebfc65dbb |
| SEA-10 | Damage, flooding, capsize, sinking | none | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 533cc7249 |
| SEA-11 | Wave impact: slamming, green water | stand-in | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed d90933a42 |
| SEA-12 | Hydrodynamic loads on arbitrary bodies | none | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 5d2524732 |
| SEA-13 | Whitewater, foam, bubbles, spray generation | stand-in | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed e9007d3bb |
| SEA-14 | Water entry and exit | stand-in | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 12b84154b |
| SEA-15 | Tracers and slicks in water | stand-in | Codex | BUILDING (codex/physics-sand-puff-pass1) |
| FLUID-03 | FLIP and APIC grid-particle liquids | none | Claude | CLAIMED |
| HYDRO-01 | Conservative shallow water | partial | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 9a189c4eb |
| ATMO-04 | Precipitation microphysics | stand-in | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed acbc53c7e |
