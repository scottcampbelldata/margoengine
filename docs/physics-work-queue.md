# Physics work queue

Who builds which of the 104 solvers in [physics-solvers.md](physics-solvers.md), so that two agents never build the
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

### The standard: parity with Babylon.js and three.js (Scott, 2026-11-26)

Scott: "make every one on parity with Babylon and three js not exceeds but must meet", and name "the 10-15 that
absolutely have to be perfect for max adoption". This replaces the earlier "best most powerful" standard.

[physics-parity-bar.md](physics-parity-bar.md) holds everything each solver must have:

1. **Part 1, the baseline** every solver meets.
2. **Part 2, the 14 that must be perfect**, each with its full checklist (the union of both rivals, plus a quick start,
   a three.js migration note, an example page, a debug view and speed at least equal to the rival demo).
3. **Part 3, one row per solver** with its verdict: PERFECT, GAP (a rival feature to add), MEETS (done once the
   baseline holds) or DON'T BUILD (no rival has it; not built unless Scott or a film asks).

A solver is finished when it meets its row in that file. REOPENED upgrade lists in `docs/physics-solver-audit.md`
beyond that row are no longer required. A solver a film in production needs builds what that film's shots use, and
the film names it. Work in this order: item 8 of the baseline on every landed row (so `main` stays green), then the
14, then the GAP rows.

## Framework requests

The framework (`packages/physics/src/world/`, `packages/kernel-common/`, `@margoengine/math/fields`,
`@margoengine/math/pinned`, `@margoengine/math/clock`) changes only through its owners. If a solver needs a change
there, add a line below with the solver ID and what is needed, and build against what exists meanwhile.

- **SEA-12 — RESOLVED in `13b6c14dd0`.** `PhysicsWorld.shiftOrigin` validates and moves both retained mirrors
  with the solver cells, preserving ticks, rates and payloads. `SolverHost.cell` exposes the live cell between steps.
  `world.test.js` keeps the staggered reader's separation at 1.5 m. The coupled swimmer and shallow water replay
  the shifted state in `loads-swim-actuators.test.js`.
- **SEA-12 — RESOLVED in `13b6c14dd0`.** `RigidSolver` publishes effective per-axis mobility alongside the
  existing `bodies` layout. `world-rigid-solver.test.js` compares the new values with an impulse in each axis
  and held torque. KB-LOADS-INITIALCOM covers the rotated body's eccentric centre before the first step.
- **SEA-12 — RESOLVED in `13b6c14dd0`.** The registry reserves accumulator sums at first publication.
  `world-frame-zero-accumulator.test.js` covers `bodyForces` and `bodyImpulses`. The Flood browser test
  replays frame zero with live buoyancy on WebGPU and WebGL2.
- **SEA-12 gate fix (2026-11-27, by another lane on Scott's go):** `check:pinned-math` and `check:coupling` failed on main.
  The loads, crush and blast sources now use `@margoengine/math/pinned` or plain products in place of `**`, `Math.sin`,
  `Math.cos`, `Math.hypot` and `Math.cbrt` (43 places in 11 files, among them `loads/surge-wake.ts`). Seven solvers
  (`SurgeWakeCoupling`, `FreeHullWakeCoupling`, `PrescribedWakeWork`, `QuayWakeBoundary`, `ResistiveSoil`,
  `CrushShellSolver`, `GirderJointSolver`) each gained a `frameRateIndependent` and `seekEqualsContinuous` test through the
  coupling harness in their own `tests/coupling` file.

- **FLUID-01:** Connect SEA-04 and general HYDRO-01 cells to the optional DFSPH layout-1 parcel requests and
  receipts. The real HYDRO-01 wet-cell test settles signed depth and both horizontal momentum components in
  the same tick through the signed inflow and added forcing. Vertical momentum stays in a separate ledger.
  General shoreline coupling needs HYDRO-01 to reserve donor volume and report what signed volume and
  momentum the wet/dry update actually accepts. SEA-04 needs a paired debit and horizontal momentum
  receipt at the solver boundary. DFSPH now publishes current hard-contact position, time, normal impulse
  and dissipated energy through its optional impact field. SOUND-05 needs a consumer for that field and an
  entrained-bubble event contract. SOUND-04's modal contact field has a real impact producer.

- **SEA-04 / SEA-01:** Define a bidirectional boundary wave-action contract with face position and normal,
  frequency and direction bins, and accepted incident, reflected and dissipated fluxes per tick. The local
  wake can resolve a supplied incident wave. `WaveSolver` currently publishes its spectrum and has no
  input port for a reflected or dissipated flux to return to the same bins. The coupling needs one ledger
  for wave action crossing the boundary so source energy and reflected energy are each counted once.

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

- **BREAK-03:** SEA-10 reads the versioned crush, girder and live shell aperture fields to move water into compartments
  and adds the carried water mass and inertia. The crush entry exchanges normal and angular impulse through the rigid ports.
  The optional hull and crush entries share versioned contact-mobility and impulse-receipt fields for short station events.
  Those events now include instantaneous exterior added mass and carried water. Distributed shell contact still uses dry rigid inertia.

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
- **AERO-03:** Convert the framework AirSolver initialization errors for missing Physics and invalid capacity to coded errors with fixes. The optional flight entry and hold already reject invalid samples and unrepresentable loads with coded help.

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

- **KB-VOX-ORIGIN2** (voxel debris, for the owner of the `Physics` class): give `Physics` a `PhysicsWorld.shiftOrigin`-style
  rebase (bodies, velocities, sleep state and driven mesh poses kept relative to a float64 origin), so
  `@margoengine/voxel/physics` can follow it and `VoxelDebris` can accept `origin` with `physics`. It refuses the
  pair until then ([known-bugs.md](known-bugs.md)).

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

### SEA-13 whitecap shape in the Kitty Hawk s18 frame (logged by the rendering lane, 2026-11-26)

On the dune coast's swell sea (s18, `whitecaps` 0.67, wind 12 m/s) the foam forms in soft-edged bands along the 72 m
and 41 m swell crests across the frame, not in short patches on the wind-sea crests. Coverage is not the fault (0.42%
of the sea against Monahan's 1.84%). `whitecap()` in `packages/water/src/index.ts` thresholds the crest term of every
train, so the longest trains decide where foam forms, and its edge is a metre wide. Recorded as
KB-WATER-WHITECAPBANDS1 in `docs/known-bugs.md`; not changed outside SEA-13.

### SEA-02 far sea rows in the Kitty Hawk s18 frame (logged by the rendering lane, 2026-11-26)

From a few tens of metres to the horizon the s18 sea is evenly spaced parallel crest rows. The scene passes four
hand-set trains; Water's own default, `seaState(wind)`, is eight JONSWAP trains and is less regular (0.26 against 0.40
column autocorrelation in the far quarter of a bare Water view) but still a sum of trains. Water has no spectral far
sea unless a `SpectralSea` is passed as `sea`. Recorded as KB-WATER-FARROWS1 in `docs/known-bugs.md`; not changed
outside SEA-02.

### SEA-01 and SEA-13: `Water`'s refusals have no error code (logged by gap lane B, 2026-11-27)

`new Water({ color: [2, 0, 0] })` and `water.setSeaLevel(NaN)` throw a plain `RangeError`, and
`new Water({ sea: {} })` a `TypeError`, with no code or help link: about 30 refusals in
`packages/water/src/index.ts`, a file the SEA-01 and SEA-13 rows list. Recorded as KB-WATER-CODED1 in
`docs/known-bugs.md`; not changed by lane B. Fixed 2026-11-27 by gap lane E (error classes only, no solver or draw code;
`packages/water/test/coded-errors.test.js`).

### SEA-13: a seek cannot rebuild the FFT sea's older foam (GAP-FILM-FOAM, logged by gap lane B, 2026-11-27)

The foam of the FFT ocean (`packages/water/src/fft.ts`, a SEA-13 file) is GPU history with a lifetime of 4 s by
default, so a film that seeks to a cut starts with no foam, and a warm-up of P seconds leaves e^(-P/lifetime) of the
older foam out. Wanted from the SEA-13 owner: exact foam at the cut time (a warm-up run from the closed-form waves
inside the engine). Bound until then: mean foam within 5 percent after a warm-up of three lifetimes. Not changed by
lane B.

### SEA-08: a heeled box's roll decays 13 percent slower than measured (KB-SEA-HEELDECAY1, logged by physics lane P, 2026-11-28)

`packages/physics/tests/coupling/seakeeping.test.js` "let go heeled" is red on main: HullSolver's roll decay coefficient K
is 0.288 against Jung, Chang and Jo's measured 0.333 (bar 12 percent). Cause not traced. Repro and state in
`docs/known-bugs.md`; not changed outside SEA-08.

### SOFT-05: a tissue's sliding attachment misses its closed form by 1.6 times the rounding bound (KB-SOFT-SLIDEATTACH1, logged by physics lane P, 2026-11-28)

`packages/physics/tests/coupling/tissue.test.js` "sliding attachment" is red on main: the particle ends at 0.5100431
against the closed form 0.5100446 (1.5e-6 off, bound 16 float32 spacings). Cause traced: the soft world's face air drag acts on the tissue's cell surface;
the one-line fix is in `packages/physics/src/soft.ts` (SOFT-01, SOFT-04 and SOFT-06's file), set out in `docs/known-bugs.md`.

### SOFT-04: a volumetric rung stops cracking under continued remeshing (KB-SOFT-CRACKRES1, logged by physics lane P, 2026-11-28)

`packages/physics/tests/coupling/volumetric-solids.test.js` "automatic cracks remain finite" is red on main: the tensile
ladder at strain rate 0.005 makes 8 cracks or fewer in 18 steps where the test asks for more. Repro and state in
`docs/known-bugs.md`; left to the SOFT-04 owner.

## Scope: solvers only (Scott, 2026-11-26)

The physics engine is the whole job. It is built in two stages:

1. **Now:** the 104 physics solvers in `docs/physics-solvers.md`, each to its row in `docs/physics-parity-bar.md` (see "The standard" above).
2. **After the solvers are done:** the rest of the physics engine. That means parity rows that are not solver
   capabilities, physics tooling (replay debugger, profiler, shape cache), rollback and snapshot sync, and the
   internal refactors.

Nothing outside the physics packages is touched in either stage. A failure in another package is reported to its
owner, not fixed here.

## One solver at a time, start to finish (Scott, 2026-11-26)

**Four-point pass (Scott, 2026-11-27).** Bring the lowest-scoring built solvers up to four of the eight
points first. Hold one BUILDING row at a time. Record the exact four points and their evidence when
releasing the row as REOPENED for the full pass. Reserve LANDED and VERIFIED for the full standard.
Resume the eight-point upgrades after every eligible built solver has reached four. Keep existing
ownership and exclusions.

Scott: "complete wave all the way start to finish until it's done and passes all eight test and wire it into anything
that it connects to." Each builder works on ONE row at a time:

1. Take the next row in the order below and set it BUILDING with your name. Hold no other row BUILDING.
2. Finish every numbered item of its list in `docs/physics-solver-audit.md` and its row in `docs/physics-parity-bar.md`,
   in every package the solver touches: physics, water, weather, shot, renderer, README, limits and examples.
3. Wire it into every solver and package it connects to, both ways, with a coupling test for each connection.
4. Set it LANDED with one line per audit item naming its commit and test. The verifier checks it straight away.
5. Start the next row only when this one is VERIFIED. If the verifier sends it back, fix that before anything else.

Film solvers are split so both sides finish them at once (Scott, 2026-11-26: "get the solvers done for the videos").
- Claude finishes and lands what each of its lanes has in progress, so no work is done twice. That means SEA-09,
  SOFT-01, FLUID-03, the deck props on a moving hull (EF-3) and the joint and 2D rows already started. Then it builds
  the RAF Fauld explosion film's solvers: FIRE-05, FIRE-04, EARTH-06, FIRE-03, EARTH-03, HYDRO-05 and BREAK-02.
- Codex does the water and the ships, in this order: SEA-12, SEA-04, SEA-02, SEA-13, SEA-14, SEA-08, SEA-11, SEA-10,
  SEA-15, FLUID-07, BREAK-03, SEA-03, SEA-01, SEA-05, SEA-07, ATMO-04, ATMO-06. Then the reef film's LIFE-03, LIFE-04
  and BIO-01, then every other REOPENED row, then the Open rows.

## Who builds what (Scott, 2026-11-26)

- Codex builds every row in the Open table below, plus the rows it has claimed.
- Claude builds the rows in the Taken table.
- Solvers for films in production come first.
- When both lists are built, every solver is checked against its row in `docs/physics-parity-bar.md`. A row that
  falls short is REOPENED with the missing parity items named, and closes when it meets that row.
- Handed to Codex (Scott, 2026-11-26), so the Claude side stays on the film solvers: DYN-07, AERO-01 to AERO-03
  and ATMO-01 to ATMO-03. The AERO and ATMO rows are built and REOPENED; build their upgrades from
  `docs/physics-solver-audit.md`.
- Parity (Scott, 2026-11-26: "I want 100% parity"): every PARTIAL or MISSING row in `docs/rapier-parity.md`,
  `docs/rapier-parity-2d.md` and `docs/physics-collision-parity.md` is finished to DONE by the owner its Owner column
  names. Rows with no solver are assigned here:
  - 2D soft bodies (S2-01 to S2-12, SB-03, and the 2D parts of SB-01, SB-12 and SB-17): Claude, with SOFT-02.
  - X-60 unified particles: Codex, with FLUID-01 and FLUID-02.
  - X-81 rollback, X-82 snapshot sync, X-84 replay debugger, X-85 per-island profiler and X-86 binary shape cache
    are physics-engine work for the second stage, after the solvers. Until then they stay MISSING, with no owner.
- Upgrades (Scott, 2026-11-26): Codex builds every upgrade, on every REOPENED row, whoever first built it. Claude
  finishes the builds it still has CLAIMED, then verifies: each row Codex sets LANDED is checked and set VERIFIED,
  or REOPENED with reasons.

## Open

| ID | Solver | State today | Owner | Status |
| --- | --- | --- | --- | --- |
| DYN-08 | Large-scale GPU rigid dynamics | none | Open | OPEN |
| SOFT-04 | Volumetric solids (FEM) | native FEM, Projective Dynamics and finite-chain rubber with reciprocal contact, cutting and fracture; `SoftBodyDesc.volume` from any mesh, its `tier: 'cells'` isosurface-stuffed and Hertz-checked | Claude (laptop), on Scott's order, 2026-11-27 | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed a0de32ed1b |
| SOFT-06 | Pressure bodies | physics/soft with sealed gas and rigid contact; `SoftBodyDesc.volume(mesh, {pressure})` | Claude (laptop), on Scott's order, 2026-11-27 | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed a82ff99eb9 |
| BREAK-04 | Exterior ballistics | partial | Open | OPEN |
| BREAK-05 | Terminal ballistics and impact damage | stand-in | Open | OPEN |
| LIFE-02 | Limbless, insect and small-animal locomotion | physics/locomotion and signed live terrain scene | Codex | REOPENED (4/8 at b20d78c528, points 5–8, [evidence](physics-solver-audit.md#life-02-four-point-pass)), prior landing 6712e2b2a4 |
| LIFE-07 | Machine dynamics with actuators | stand-in | Open | OPEN |
| AERO-04 | Turbomachines in flow | none | Open | OPEN |
| AERO-05 | Falling and tumbling light bodies | falling plates, winged seeds, swept hail and live samara scene | Codex | REOPENED (4/8 at c33e207d1b, points 5–8, [evidence](physics-solver-audit.md#aero-05-four-point-pass)), prior landing c82d68bf98 |
| SEA-03 | Nonlinear waves, rogue waves | physics/rogue and live launch cutaway | Codex | REOPENED (4/8 at 0f282397e6, points 5–8, [evidence](physics-solver-audit.md#sea-03-four-point-pass)), prior landing 47be5f699 |
| SEA-06 | Tsunami and impulse waves | none | Codex | REOPENED (4/8 at a437d9db30, points 5–8, [evidence](physics-solver-audit.md#sea-06-four-point-pass)), prior landing 1905b1c216 |
| SEA-07 | Tides, storm surge and currents | physics/surge and live Sun–Moon cutaway | Codex | REOPENED (4/8 at 7e2a01c13d, points 5–8, [evidence](physics-solver-audit.md#sea-07-four-point-pass)), prior landing e5462e9cc |
| FLUID-05 | Compressible flow, shock and blast | none | Open | OPEN |
| FLUID-06 | Viscoplastic fluids at small scale | partial | Codex | REOPENED (4/8 at e3bd12821b, points 5–8, [evidence](physics-solver-audit.md#fluid-06-four-point-pass)), prior landing a540dd915c |
| FLUID-07 | Thin films and droplets on surfaces | physics/thin-film and live pane cutaway | Codex | REOPENED (4/8 at 119f92f328, points 5–8, [evidence](physics-solver-audit.md#fluid-07-four-point-pass)), prior checkpoint 3cb9cb3ebc |
| HYDRO-02 | Rainfall-runoff and infiltration | soil wetting, watershed hydrographs and flood coupling | Codex | REOPENED (4/8 at 58bd4188d0, points 5–8, [evidence](physics-solver-audit.md#hydro-02-four-point-pass)), prior landing 9f6f7e9004. Note (Claude (Scott 2026-11-28), physics lane P): `runoff/index.ts` takes `hypot` from `@margoengine/math/pinned` where its reach length overflowed to `Math.hypot` (`check:pinned-math`); no other change |
| HYDRO-04 | Landscape evolution | implicit incision, soil transfer and physical Biomes relief | Codex | REOPENED (4/8 at 897e9aa010, points 5–8, [evidence](physics-solver-audit.md#hydro-04-four-point-pass)), prior landing dc75a47d35 |
| HYDRO-05 | Dam and levee breach | stand-in | Claude | CLAIMED (Fauld film) |
| HYDRO-06 | Groundwater and springs | native aquifer assembly and live spring-to-shallow-water release | Codex | REOPENED (4/8 at 507df10bf7, points 5–8, [evidence](physics-solver-audit.md#hydro-06-four-point-pass)), prior landing b6e01ceb4c |
| ATMO-05 | Tropical cyclones and large vortices | physics/vortices and Sky | Codex | REOPENED (4/8 at e56545a625, points 5–8, [evidence](physics-solver-audit.md#atmo-05-four-point-pass)) |
| ATMO-06 | Airborne particle transport | physics/airborne and environment/density-volume | Codex | REOPENED (4/8 at a65111cd3a, points 5–8, [evidence](physics-solver-audit.md#atmo-06-four-point-pass)), prior landing 965fab2df7 |
| ATMO-07 | Lightning and atmospheric electricity | physics/lightning and Sky LightningBolt | Codex | REOPENED (4/8 at 6bcaf278f3, points 5–8, [evidence](physics-solver-audit.md#atmo-07-four-point-pass)), prior landing 51ccc096bc |
| ATMO-08 | Fog and cold-air drainage | physics/drainage-fog and environment/fog-volumes | Codex | REOPENED (4/8 at e2dee8854c, points 5–8, [evidence](physics-solver-audit.md#atmo-08-four-point-pass)), prior landing 80679b25b4 |
| ATMO-09 | Surface energy balance | surface temperature, liquid and snow budgets, wetness and fuel | Codex | REOPENED (4/8 at c885f8db50, points 5–8, [evidence](physics-solver-audit.md#atmo-09-four-point-pass)), prior landing 93bf3f2435 |
| EARTH-03 | Particle-laden gravity currents | partial | Claude | CLAIMED (Fauld film) |
| EARTH-05 | Terramechanics | physics/terramechanics with native soil, live rigid and legged contacts, and mineral dust | Codex | REOPENED (4/8 at cdefe2ee68, points 5–8, [evidence](physics-solver-audit.md#earth-05-four-point-pass)), prior upgrade parts c99bb12d2a and 0fa769d6dc |
| EARTH-06 | Impact and explosion cratering | stand-in | Claude | LANDED 2026-11-27: `@margoengine/physics/crater`, `craterSize` and `CraterSolver` (FIRE-05's explosions to the terrain bed), validated on craters not fitted, Sedan's blanket and Fauld's throw; limits in docs/limits.md |
| EARTH-07 | Aeolian transport | physics/aeolian | Codex | REOPENED (4/8 at 5348518fdc, points 5–8, [evidence](physics-solver-audit.md#earth-07-four-point-pass)), prior landing d2fa3cb303 |
| EARTH-08 | Seismic waves and ground shaking | physics/seismic | Codex | REOPENED (4/8 at 27eeda9cac, points 5–8, [evidence](physics-solver-audit.md#earth-08-four-point-pass)), prior landing 32c933e9d0 |
| EARTH-09 | Volcanic eruption column | partial | Open | OPEN |
| EARTH-10 | Lava flow | partial | Codex | REOPENED (4/8 at 99d66dbc47, points 5–8, [evidence](physics-solver-audit.md#earth-10-four-point-pass)), prior landing 3a35fac405 |
| ICE-01 | Snowpack | physics/snowpack, Weather Snow and live basin runoff | Codex | REOPENED (4/8 at 316b7367c1, points 5–8, [evidence](physics-solver-audit.md#ice-01-four-point-pass)), prior landing 7f5ad4a8d2 |
| ICE-02 | Glacier and ice-sheet flow | physics/glacier and live tidewater release | Codex | REOPENED (4/8 at 72e4b4d57b, points 5–8, [evidence](physics-solver-audit.md#ice-02-four-point-pass)), prior landing 096242cb21 |
| ICE-03 | Iceberg rigid-body dynamics and calving | physics/iceberg and live signed wake | Codex | REOPENED (4/8 at a71611f852, points 5–8, [evidence](physics-solver-audit.md#ice-03-four-point-pass)), prior landing 7dbf9e06ee |
| ICE-04 | Pack ice and floes | physics/pack-ice and live vessel contacts | Codex | REOPENED (4/8 at 50e4e322ce, points 5–8, [evidence](physics-solver-audit.md#ice-04-four-point-pass)), prior landing dbc7a0efd9 |
| ICE-05 | Ice thermodynamics | physics/ice | Codex | REOPENED (4/8 at 539f1f526a, points 5–8, [evidence](physics-solver-audit.md#ice-05-four-point-pass)), prior landing 7b64dddf4f |
| FIRE-04 | Explosive blast loading | built: free-air blast laws, Friedlander wave, arrival, reflection, loads on rigid bodies and breakables from FIRE-05, pressureAt; validated against Ford et al.'s field-measured surface impulse | Claude | LANDED 2026-11-27 (Fauld film), to the verifier |
| FIRE-05 | Explosive source and fragments | built: charge energy budget (air, ground shock, crater work, heat), Gurney and Mott fragments, gun interior ballistics and recoil both ways with rigid carriers, Rust/Wasm SIMD flight landing on the terrain bed, hits into rigid bodies, breakables and hull plates, film direction, the kernel on 1 to 64 worker threads with the same bits; the parity baseline holds | Claude | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md), pass 6), landed 00d9fdf9b; items 1, 2, 3, 5 and 6 fixed; item 4 with the lane manager |
| FIRE-06 | Heat conduction and phase change | heat, phase change and thermoelasticity | Codex | REOPENED (4/8 at 127472895c, points 5–8, [evidence](physics-solver-audit.md#fire-06-four-point-pass)), prior landing e497def90e |
| FIRE-07 | Burning of structures, ships and solids | stand-in | Open | OPEN |
| SOUND-01 | Outdoor propagation | physics/outdoor-sound and audio/outdoor | Codex | REOPENED (4/8 at 3a2e5a1029, points 5–8, [evidence](physics-solver-audit.md#sound-01-four-point-pass)), prior landing 976796766b |
| SOUND-02 | Enclosed and urban acoustics | physics/room-sound | Codex | REOPENED (4/8 at 1956fb9218, points 5–8, [evidence](physics-solver-audit.md#sound-02-four-point-pass)), prior landing bb16680105 |
| SOUND-03 | Underwater acoustics | physics/underwater | Codex | REOPENED (4/8 at 85765e0ef8, points 5–8, [evidence](physics-solver-audit.md#sound-03-four-point-pass)), prior landing 9f850999d0 |
| SOUND-04 | Contact and modal sound | none | Codex | REOPENED (4/8 at b23fdc911c, points 5–8, [evidence](physics-solver-audit.md#sound-04-four-point-pass)), prior landing e0b1f274ab |
| SOUND-05 | Physics-driven fluid, fire, wind and machine sound | none | Open | OPEN |
| BIO-02 | Plant growth and morphogenesis | biomes/growth with HYDRO-02 soil and live Procedural branch graphs | Codex | REOPENED (4/8 at ba3941ca5d, points 5–8, [evidence](physics-solver-audit.md#bio-02-four-point-pass)), prior landing d5e70fde20 |
| BIO-03 | Forest ecosystem dynamics | sound | Codex | REOPENED (4/8 at 1476595e04, points 5–8, [evidence](physics-solver-audit.md#bio-03-four-point-pass)), prior landing 609d76e5ce |
| BIO-04 | Material ageing | material exposure, decay and PBR appearance | Codex | REOPENED (4/8 at a9332e0abb, points 5–8, [evidence](physics-solver-audit.md#bio-04-four-point-pass)), prior landing 9632f2731c |
| SPACE-01 | N-body and orbital dynamics | physics/orbit | Codex | REOPENED (4/8 at 06bda264b7, points 5–8, [evidence](physics-solver-audit.md#space-01-four-point-pass)), prior landing 56f09d5d54 |
| SPACE-02 | Celestial ephemeris and rotation | partial | Codex | REOPENED (4/8 at bb86ef47c6, points 5–8, [evidence](physics-solver-audit.md#space-02-four-point-pass)), prior landing 18dbe0de5e |
| SPACE-03 | Accretion disks and motion near compact objects | physics/accretion with viscous transport and geodesics | Codex | REOPENED (4/8 at 58d338d44e, points 5–8, [evidence](physics-solver-audit.md#space-03-four-point-pass)), prior landing 0c11fd27f7 |
| DYN-04 | Wheeled vehicles on roads | partial | Claude (laptop), on Scott's order, 2026-11-27 | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 18ded2be7c; P5 parity (arcade car, debug lines, coded errors, migration note, example page) landed 2026-11-27 |
| DYN-05 | Rail vehicle dynamics | physics/rail | Codex | REOPENED (4/8 at 59abbb0f64, points 5–8, [evidence](physics-solver-audit.md#dyn-05-four-point-pass)), prior landing fa79b04868 |
| SOFT-03 | Hair, fur, mane, tail, feathers, spring bones | native rods, fast guides and physical skin bindings | Codex | REOPENED (4/8 at 2d3a281145, points 5–8, [evidence](physics-solver-audit.md#soft-03-four-point-pass)), prior landing c53e60dc12 |
| SOFT-05 | Muscle, fat and skin soft tissue | physics/tissue with skeletal pins, sliding planes and passive layers | Open | OPEN |
| BREAK-01 | Brittle and ductile fracture, destruction | physics/breakable: convex Voronoi fracture into convex rigid pieces, bond graph with anchors, contact and blast damage, debris policy | Claude (laptop), taken over from Gemini on Scott's order, 2026-11-27 | LANDED b63a217ba (P9 of docs/physics-parity-bar.md) |
| BREAK-02 | Structural collapse and load path | stand-in | Claude | CLAIMED (Fauld film) |
| BREAK-03 | Ductile crushing: hulls, car bodies, rail cars | physics/crush and live fender cutaway | Codex | REOPENED (4/8 at dcdd72fd18, points 5–8, [evidence](physics-solver-audit.md#break-03-four-point-pass)), prior checkpoint 839a45208b |
| LIFE-01 | Legged animal locomotion (quadrupeds, bipeds) | physics/legged with live terrain and rigid decks and Horses gait drive | Codex | REOPENED (4/8 at 5123bed666, points 5–8, [evidence](physics-solver-audit.md#life-01-four-point-pass)), prior landing 64bedcf038 |
| LIFE-03 | Aquatic locomotion | physics/life and environment ray-sediment cutaway | Codex | REOPENED (4/8 at 850df734e6, points 5–8, [evidence](physics-solver-audit.md#life-03-four-point-pass)), prior landing 708e96a06b |
| LIFE-04 | Collective animal motion | deterministic schooling, physical steering and intent ports | Claude (laptop), taken over from Gemini on Scott's order, 2026-11-27 | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 006faf6368; P14 GPU path (`@margoengine/vfx/flocking`) landed 2026-11-27 |
| LIFE-05 | Pedestrian and dense-crowd dynamics | physics/pedestrians and mass-weighted NavMesh avoidance | Codex | REOPENED (4/8 at 8bdf2ce5cf, points 5–8, [evidence](physics-solver-audit.md#life-05-four-point-pass)), prior landing 561885e7a1 |
| LIFE-06 | Mass formations and cavalry charge | stand-in | Open | OPEN |
| FLUID-01 | SPH, divergence-free (accurate mode) | none | Open | OPEN |
| FLUID-02 | Position based fluids (fast mode) | none | Claude (laptop), on Scott's order, 2026-11-27 | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 14a5956173; P13 GPU path (`GPULiquid`, `@margoengine/water/liquid`) landed 2026-11-27 |
| FLUID-04 | Eulerian smoke and gas | stand-in | Open | OPEN |
| HYDRO-03 | Sediment transport and channel morphodynamics | physics/sediment and water/shallow-surface | Codex | REOPENED (4/8 at 0991351637, points 5–8, [evidence](physics-solver-audit.md#hydro-03-four-point-pass)), prior landing db1950c88f |
| ATMO-10 | Synoptic weather and moisture transport | stand-in | Codex | REOPENED (4/8 at 34145ff6d6, points 5–8, [evidence](physics-solver-audit.md#atmo-10-four-point-pass)), prior landing d19267aa1e |
| EARTH-01 | MPM continuum | stand-in | Open | OPEN |
| EARTH-02 | Depth-averaged granular flow | partial | Open | OPEN |
| EARTH-04 | Discrete-element rubble and boulders | partial | Open | OPEN |
| FIRE-01 | Wildfire spread | partial | Open | OPEN |
| FIRE-02 | Flame and fireball | stand-in | Open | OPEN |
| FIRE-03 | Integral plume and thermal model | partial | Claude | CLAIMED (Fauld film) |
| BIO-01 | Plant mechanics under wind and water | physics/vegetation and scatter/plant-motion | Codex | REOPENED (4/8 at a638e82e14, points 5–8, [evidence](physics-solver-audit.md#bio-01-four-point-pass)), prior landing a4d123a968 |
| DYN-07 | Dynamic character, balance, push response | partial: shared debug view and character-ragdoll bridge landed | Claude (laptop), taken over from Gemini on Scott's order, 2026-11-27 | BUILDING |
| AERO-01 | Aerodynamic loads on bodies | physics WindForce and AirSolver | Codex | REOPENED (4/8 at d4370faed2, points 5–8, [evidence](physics-solver-audit.md#aero-01-four-point-pass)), prior landing 48b593a13 |
| AERO-02 | Membrane aerodynamics (FSI) | none | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 2f1860412 |
| AERO-03 | Flight dynamics (wings, rotors, bodies) | none | Codex | REOPENED (4/8 at 0fbedc538b, points 5–8, [evidence](physics-solver-audit.md#aero-03-four-point-pass)), prior landing f9161cc7e |
| ATMO-01 | Boundary-layer wind field | physics/boundary-layer and weather/boundary-layer | Codex | REOPENED (4/8 at 9d7dd26bc5, points 5–8, [evidence](physics-solver-audit.md#atmo-01-four-point-pass)), prior landing c38c25d3d |
| ATMO-02 | Atmospheric turbulence and gusts | weather/turbulence and scatter/plant-motion | Codex | REOPENED (4/8 at df2e11c99e, points 5–8, [evidence](physics-solver-audit.md#atmo-02-four-point-pass)), prior landing c38c25d3d |
| ATMO-03 | Moist convection and cloud dynamics | physics/clouds and environment/density-volume | Codex | REOPENED (4/8 at 9622992eda, points 5–8, [evidence](physics-solver-audit.md#atmo-03-four-point-pass)), prior landing 8833dbf0c. Note (Claude (Scott 2026-11-28), physics lane P): `clouds/convection.ts` writes its two `**` as `1 << 21` and a product (`check:pinned-math`), the same values |

## Taken

Claimed by Claude: the framework's foundation, the ship at sea (hull, ocean, wakes, spray, wind, rain) and the rigid core. Do not start these.

KB2161 (docs/known-bugs.md, "a chain laid out level under a 1000:1 end mass stretched once it was taut, and opened at every snap"): fixed 2026-11-28 (Claude, workstation, on Scott's order). The stretch landed 2026-11-27 (the geometric stiffness of the joint locks, `taut_inertia`); the snaps on 2026-11-28 (locks closed at the end pose on each path's Newton matrix, the midpoint rule, damping of a taut lock's free motion past h^2 k = 4 m, `packages/physics/kernel/src/joints.rs`, clean-room PK68). The 100,000:1 chain is a separate open entry in docs/known-bugs.md and is not claimed.

| ID | Solver | State today | Owner | Status |
| --- | --- | --- | --- | --- |
| SEA-05 | Nearshore waves and surf zone | physics/surf and live wet-sand cutaway | Codex | REOPENED (4/8 at d01b0c6751, points 5–8, [evidence](physics-solver-audit.md#sea-05-four-point-pass)), prior landing 8c7453cd8 |
| DYN-01 | 3D rigid body and contact | sound; P1 work landed 2026-11-27: fields, instanced bodies, contactcontinue, coded errors, example page, validation suite; open points listed under physics-parity-bar.md P1; KB-PHYS-HUNGCRADLE1 fixed on Scott's ruling while the owner was offline, see the DYN-01 handoff in physics-solver-audit.md | Claude (laptop), on Scott's order, 2026-11-27 | CLAIMEDNote (Claude (Scott 2026-11-28), physics lane P): KB-PHYS-CONECUT1 and KB-PHYS-RESTDEPTH1 fixed in `kernel/src/solver.rs` (`friction_rows` converges in a pair; `normal_rows` gives a point closed to the slop to the spring), tests in `kernel/tests/solver.rs`, replay hashes rewritten Second note (same lane): KB-PHYS-CCDKNOCK1 fixed by strike pieces, new `kernel/src/strike.rs` called from `solve_island`, with `refresh_pair` in `narrow.rs` and `prepare_rows` factored out of `prepare_contacts` in `solver.rs`; islands with no CCD body run the old path to the bit; tests `kernel/tests/strike.rs`, `threads.rs`; what it does not cover is KB-PHYS-CCDKNOCK2 |
| DYN-02 | 2D rigid body | sound | Claude | CLAIMED |
| DYN-03 | Articulated bodies, joints, motors, robots | P3 parity: limits and motors on every free axis, coded errors, joint debug view, quick start, migration note, example page (see physics-parity-bar.md P3) | Claude (laptop), on Scott's order, 2026-11-27 | LANDED 2026-11-27. Note for the owner (2026-11-28, another Claude session on Scott's standing order): couplings now solve on the Schur complement of the joints' locks and go before the joints in each pass, and gear and rack errors are read from the poses (KB-PHYS-PATHMOVINGBASE1, KB-PHYS-COUPLINGDRIFT1 fixed; `kernel/src/couplings.rs`, `kernel/tests/coupling_exact.rs`). Second note (2026-11-28, same order): causes of KB-PHYS-SPINBIAS1 (forces enter before the poses move, the joints' centripetal turn after) and KB-PHYS-SARRUSLOOP1 (a near singular path's push cut whole by `push_share`) are in docs/known-bugs.md with what was tried; no solver file changed. Third note (2026-11-28, same order): `kernel/src/events.rs` changed, no solver file: pair walks outside the step pass by a pair whose other collider was removed (KB-PHYS-RETIREDPAIR1, `kernel/tests/retired_pair.rs`). KB-PHYS-SARRUSLOOP1 is not landed: its `push_share` fix and a damped push for `joints.rs` are held back because the replay scene shows a second defect they uncover, pushes feeding the islands' own substep levels (measured in docs/known-bugs.md); KB-PHYS-SPINBIAS1 waits behind it, as both touch `joints.rs`. |
| DYN-06 | Mass properties and collision geometry | partial: PA-09 and coded mesh errors landed 2026-11-27; PA-87 open (see physics-parity-bar.md P2) | Claude (laptop), on Scott's order, 2026-11-27 | CLAIMED |
| SOFT-01 | Cloth and thin shells | partial: water as a medium landed 1b7d95a48, curtains in a moving hull 3d1e785d7, GPU cloth (`@margoengine/physics/gpu-cloth`) and its example page 2026-11-27 | Claude (laptop), on Scott's order, 2026-11-27 | CLAIMED |
| SOFT-02 | Rods, ropes, cables, chains (Cosserat) | elastic rods (`@margoengine/physics/rod`: bend, twist and stretch in a multibody's direct solve, pins, cast-off) with water loads per segment (`segmentLoads` in `@margoengine/physics/loads`: buoyancy, Morison drag and inertia, vortex lift); validated against a cantilever in a current, a catenary, a taut cable's frequency and strumming lock-in (`packages/physics/tests/rod.test.js`, `loads-segments.test.js`) | Claude | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 7bcfb11e3 |
| SEA-01 | Wave spectrum and wave-field evolution | physics/waves and live swell cutaway | Codex | REOPENED (4/8 at 5429226e54, points 5–8, [evidence](physics-solver-audit.md#sea-01-four-point-pass)), prior landing 62fa8c303 |
| SEA-02 | Ocean surface synthesis and query | partial | Claude (laptop) | P10 CHECKLIST MET 2026-11-27 (taken over from Gemini on Scott's order; sample, setWind, debug view, seaSurface floating, quick start, migration note, examples/ocean.html); speed unmeasured until the speed phase. REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 52b68ca65 |
| SEA-04 | Local dispersive free surface | stand-in | Codex | REOPENED for the full audit. P11 CHECKLIST MET 2026-11-27 (Claude took over from Gemini on Scott's order; obstacles, trackBody, disturbRay, cpu queries and snapshot, RippleField, seaSurface floating, debug view, quick start, migration note, examples/water-ripples.html); speed unmeasured until the speed phase. Last production checkpoint `03657797a3`; [remaining audit](physics-solver-audit.md). |
| SEA-08 | Ship seakeeping | stand-in | Codex | REOPENED (4/8 at 5b8388a0c0, points 5–8, [evidence](physics-solver-audit.md#sea-08-four-point-pass)), prior checkpoint 0ae7b50ae2 |
| SEA-09 | Manoeuvring, propulsion, resistance, sailing hull | none | Claude | LANDED 2026-11-27 after pass 5's five items ([physics-solver-audit.md](physics-solver-audit.md)): the unsourced advance removed and every shallow-water source checked (08b6158e2); squat at Huuska's limit and the shaft at KCS's published height (1e0083389); the catalog row (156359a01); bank forces by Lataire's model fitted to Vantorre's tests and checked on two hulls not fitted (9b23b5ecc); every hand-set bound derived from measured scatter (3a29a0c55), the VPP sailing ORC's No Spinnaker configuration (ccd0b17fd), and the accepted differences in docs/limits.md |
| SEA-10 | Damage, flooding, capsize, sinking | physics/seakeeping and Water cutaway | Codex | REOPENED (4/8 at 42ea5bda33, points 5–8, [evidence](physics-solver-audit.md#sea-10-four-point-pass)), prior landing 533cc7249 |
| SEA-11 | Wave impact: slamming, green water | stand-in | Codex | REOPENED (4/8 at debcbf19fd, points 5–8, [evidence](physics-solver-audit.md#sea-11-four-point-pass)), prior landing d90933a42 |
| SEA-12 | Hydrodynamic loads on arbitrary bodies | none | Claude (laptop) | P12 BUILDING, on Scott's order, 2026-11-27 (LoadSolver by Codex, REOPENED and paused on Scott's direction: fine First Wake replay and independent KCS stern validation remain open, see [audit](physics-solver-audit.md)): one-call `floating`, `bodyLoad`, `debugRender`, `examples/floating.html`, buoyancy at the energy-neutral pose (KB-LOADS-HEAVEGAIN1), wave radiation by default validated on Kramer et al.'s sphere; open points under P12 in [physics-parity-bar.md](physics-parity-bar.md) |
| SEA-13 | Whitewater, foam, bubbles, spray generation | stand-in | Codex | REOPENED (4/8 at 96d21889b9, points 5–8, [evidence](physics-solver-audit.md#sea-13-four-point-pass)), prior landing e9007d3bb |
| SEA-14 | Water entry and exit | stand-in | Codex | REOPENED (4/8 at f5005a1986, points 5–8, [evidence](physics-solver-audit.md#sea-14-four-point-pass)), prior landing 12b84154b |
| SEA-15 | Tracers and slicks in water | physics/tracers and live plume cutaways | Codex | REOPENED (4/8 at 3809dc24da, points 5–8, [evidence](physics-solver-audit.md#sea-15-four-point-pass)), prior checkpoint 336a4413c4 |
| FLUID-03 | FLIP and APIC grid-particle liquids | `physics/flip`: APIC liquid box on the world, held to the sea at its open sides (waves in, water out to the wake), solid slip, aeration and spray for SEA-13, 2-D and 3-D dam breaks | Claude (laptop), on Scott's order, 2026-11-27 | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), built 290aba7e2, 2232ca7c4, 4e2e6f26d, 4ec0717e8, 0dddec890, dbe79b009, efd218e88, e998f2989, 815e0fc77; short of the standard on the Wasm port, two-way wave passage, KB-FLIP-CREST1 and the MARIN validation; P13 GPU path (`GPULiquid`, `@margoengine/water/liquid`) landed 2026-11-27 |
| HYDRO-01 | Conservative shallow water | partial | Codex | REOPENED (see [physics-solver-audit.md](physics-solver-audit.md)), landed 9a189c4eb |
| HYDRO-07 | Pipe flow, hydraulic structures and hydraulic machines | none: eight web demos carried their own models | Claude (hydraulics lane), on Scott's order, 2026-11-27 | LANDED (2f00385a41; the eight demos moved in 06e3f74b26, 68c0700710, ab47047ce4). Note for HYDRO-06 (Codex): groundwater/index.ts re-exports the new confined.ts (solveConfinedFlow, traceStreamlines) |
| ATMO-04 | Precipitation microphysics | weather/precipitation, K23 and live water contacts | Codex | REOPENED (4/8 at 724edba73f, points 5–8, [evidence](physics-solver-audit.md#atmo-04-four-point-pass)), prior landing acbc53c7e |
