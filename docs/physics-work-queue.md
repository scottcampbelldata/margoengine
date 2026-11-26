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
  failure. No loosened bounds, no fitted constants, no hard caps written up as limits.
- CPU-heavy loops go in a Rust crate compiled to Wasm with SIMD (one crate per family, loaded lazily by its optional
  entry). The public API stays TypeScript. Core and stage gain zero bytes.
- Docs in the same push: a README example that runs, the clean-room record, `docs/limits.md`, `docs/known-bugs.md`,
  and `npm run api:update` for new exports. Gate before every push as AGENTS.md describes (never `npm run verify`).

## Framework requests

The framework (`packages/physics/src/world/`, `packages/kernel-common/`, `@margoengine/math/fields`,
`@margoengine/math/pinned`, `@margoengine/math/clock`) changes only through its owners. If a solver needs a change
there, add a line below with the solver ID and what is needed, and build against what exists meanwhile.

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

## Open

| ID | Solver | State today | Owner | Status |
| --- | --- | --- | --- | --- |
| DYN-08 | Large-scale GPU rigid dynamics | none | Open | OPEN |
| SOFT-04 | Volumetric solids (FEM) | partial | Open | OPEN |
| SOFT-06 | Pressure bodies | none | Open | OPEN |
| BREAK-04 | Exterior ballistics | partial | Open | OPEN |
| BREAK-05 | Terminal ballistics and impact damage | stand-in | Open | OPEN |
| LIFE-02 | Limbless, insect and small-animal locomotion | physics/locomotion with TerrainBed and stance wrenches | Codex | LANDED 6712e2b2a4 |
| LIFE-07 | Machine dynamics with actuators | stand-in | Open | OPEN |
| AERO-04 | Turbomachines in flow | none | Open | OPEN |
| AERO-05 | Falling and tumbling light bodies | falling plates, winged seeds and swept hail | Codex | LANDED c82d68bf98 |
| SEA-03 | Nonlinear waves, rogue waves | none | Claude | LANDED 47be5f699 |
| SEA-06 | Tsunami and impulse waves | none | Open | OPEN |
| SEA-07 | Tides, storm surge and currents | none | Claude | CLAIMED |
| FLUID-05 | Compressible flow, shock and blast | none | Open | OPEN |
| FLUID-06 | Viscoplastic fluids at small scale | partial | Open | OPEN |
| FLUID-07 | Thin films and droplets on surfaces | stand-in | Codex | BUILDING (codex/physics-lane-2) |
| HYDRO-02 | Rainfall-runoff and infiltration | soil wetting, watershed hydrographs and flood coupling | Codex | LANDED 9f6f7e9004 |
| HYDRO-04 | Landscape evolution | implicit incision, soil transfer and physical Biomes relief | Codex | LANDED dc75a47d35 |
| HYDRO-05 | Dam and levee breach | stand-in | Open | OPEN |
| HYDRO-06 | Groundwater and springs | Darcy flow, aquifer recharge and spring discharge | Codex | LANDED b6e01ceb4c |
| ATMO-05 | Tropical cyclones and large vortices | partial | Open | OPEN |
| ATMO-06 | Airborne particle transport | stand-in | Codex | BUILDING (codex/physics-atmo06-lane) |
| ATMO-07 | Lightning and atmospheric electricity | none | Open | OPEN |
| ATMO-08 | Fog and cold-air drainage | physics/drainage-fog and environment/fog-volumes | Codex | LANDED 80679b25b4 |
| ATMO-09 | Surface energy balance | surface temperature, liquid and snow budgets, wetness and fuel | Codex | LANDED 93bf3f2435 |
| EARTH-03 | Particle-laden gravity currents | partial | Open | OPEN |
| EARTH-05 | Terramechanics | stand-in | Open | OPEN |
| EARTH-06 | Impact and explosion cratering | stand-in | Open | OPEN |
| EARTH-07 | Aeolian transport | physics/aeolian | Codex | LANDED d2fa3cb303 |
| EARTH-08 | Seismic waves and ground shaking | none | Open | OPEN |
| EARTH-09 | Volcanic eruption column | partial | Open | OPEN |
| EARTH-10 | Lava flow | partial | Open | OPEN |
| ICE-01 | Snowpack | physics/snowpack and weather/avalanche | Codex | LANDED 7f5ad4a8d2 |
| ICE-02 | Glacier and ice-sheet flow | physics/glacier | Codex | LANDED 096242cb21 |
| ICE-03 | Iceberg rigid-body dynamics and calving | physics/iceberg | Codex | LANDED 7dbf9e06ee |
| ICE-04 | Pack ice and floes | stand-in | Codex | LANDED (dbc7a0efd9) |
| ICE-05 | Ice thermodynamics | physics/ice | Codex | LANDED 7b64dddf4f |
| FIRE-04 | Explosive blast loading | none | Open | OPEN |
| FIRE-05 | Explosive source and fragments | stand-in | Open | OPEN |
| FIRE-06 | Heat conduction and phase change | heat, phase change and thermoelasticity | Codex | LANDED e497def90e |
| FIRE-07 | Burning of structures, ships and solids | stand-in | Open | OPEN |
| SOUND-01 | Outdoor propagation | stand-in | Open | OPEN |
| SOUND-02 | Enclosed and urban acoustics | partial | Open | OPEN |
| SOUND-03 | Underwater acoustics | physics/underwater | Codex | LANDED 9f850999d0 |
| SOUND-04 | Contact and modal sound | none | Codex | LANDED e0b1f274ab |
| SOUND-05 | Physics-driven fluid, fire, wind and machine sound | none | Open | OPEN |
| BIO-02 | Plant growth and morphogenesis | none | Codex | BUILDING (codex/physics-bio02-resume) |
| BIO-03 | Forest ecosystem dynamics | sound | Codex | LANDED 609d76e5ce |
| BIO-04 | Material ageing | material exposure, decay and PBR appearance | Codex | LANDED 9632f2731c |
| SPACE-01 | N-body and orbital dynamics | physics/orbit | Codex | LANDED 56f09d5d54 |
| SPACE-02 | Celestial ephemeris and rotation | partial | Codex | LANDED 18dbe0de5e |
| SPACE-03 | Accretion disks and motion near compact objects | none | Open | OPEN |
| DYN-04 | Wheeled vehicles on roads | partial | Open | OPEN |
| DYN-05 | Rail vehicle dynamics | none | Open | OPEN |
| SOFT-03 | Hair, fur, mane, tail, feathers, spring bones | stand-in | Open | OPEN |
| SOFT-05 | Muscle, fat and skin soft tissue | none | Open | OPEN |
| BREAK-01 | Brittle and ductile fracture, destruction | stand-in | Open | OPEN |
| BREAK-02 | Structural collapse and load path | stand-in | Open | OPEN |
| BREAK-03 | Ductile crushing: hulls, car bodies, rail cars | physics/crush with permanent work, rigid recoil and seal loss | Codex | LANDED cf8fb29389 |
| LIFE-01 | Legged animal locomotion (quadrupeds, bipeds) | physics/legged with live terrain and rigid decks and Horses gait drive | Codex | LANDED 64bedcf038 |
| LIFE-03 | Aquatic locomotion | physics/life | Codex | LANDED 708e96a06b |
| LIFE-04 | Collective animal motion | deterministic schooling, physical steering and intent ports | Codex | LANDED 006faf6368 |
| LIFE-05 | Pedestrian and dense-crowd dynamics | physics/pedestrians and mass-weighted NavMesh avoidance | Codex | LANDED 561885e7a1 |
| LIFE-06 | Mass formations and cavalry charge | stand-in | Open | OPEN |
| FLUID-01 | SPH, divergence-free (accurate mode) | none | Open | OPEN |
| FLUID-02 | Position based fluids (fast mode) | none | Open | OPEN |
| FLUID-04 | Eulerian smoke and gas | stand-in | Open | OPEN |
| HYDRO-03 | Sediment transport and channel morphodynamics | stand-in | Codex | LANDED db1950c88f |
| ATMO-10 | Synoptic weather and moisture transport | stand-in | Open | OPEN |
| EARTH-01 | MPM continuum | stand-in | Open | OPEN |
| EARTH-02 | Depth-averaged granular flow | partial | Open | OPEN |
| EARTH-04 | Discrete-element rubble and boulders | partial | Open | OPEN |
| FIRE-01 | Wildfire spread | partial | Open | OPEN |
| FIRE-02 | Flame and fireball | stand-in | Open | OPEN |
| FIRE-03 | Integral plume and thermal model | partial | Open | OPEN |
| BIO-01 | Plant mechanics under wind and water | modal sway, windthrow and rigid impacts | Codex | LANDED a4d123a968 |

## Taken

Claimed by Claude: the framework's foundation, the ship at sea (hull, ocean, wakes, spray, wind, rain) and the rigid core. Do not start these.

| ID | Solver | State today | Owner | Status |
| --- | --- | --- | --- | --- |
| SEA-05 | Nearshore waves and surf zone | partial | Claude | LANDED 8c7453cd8 |
| DYN-01 | 3D rigid body and contact | sound | Claude | CLAIMED |
| DYN-02 | 2D rigid body | sound | Claude | CLAIMED |
| DYN-03 | Articulated bodies, joints, motors, robots | partial | Claude | CLAIMED |
| DYN-06 | Mass properties and collision geometry | partial | Claude | CLAIMED |
| DYN-07 | Dynamic character, balance, push response | partial | Claude | CLAIMED |
| SOFT-01 | Cloth and thin shells | partial | Claude | CLAIMED |
| SOFT-02 | Rods, ropes, cables, chains (Cosserat) | partial | Claude | CLAIMED |
| AERO-01 | Aerodynamic loads on bodies | stand-in | Claude | LANDED 48b593a13 |
| AERO-02 | Membrane aerodynamics (FSI) | none | Claude | LANDED 2f1860412 |
| AERO-03 | Flight dynamics (wings, rotors, bodies) | none | Claude | LANDED f9161cc7e |
| SEA-01 | Wave spectrum and wave-field evolution | stand-in | Claude | LANDED 62fa8c303 |
| SEA-02 | Ocean surface synthesis and query | partial | Claude | LANDED 52b68ca65 |
| SEA-04 | Local dispersive free surface | stand-in | Claude | LANDED 33ab69766 |
| SEA-08 | Ship seakeeping | stand-in | Claude | LANDED d865c4c8f |
| SEA-09 | Manoeuvring, propulsion, resistance, sailing hull | none | Claude | CLAIMED |
| SEA-10 | Damage, flooding, capsize, sinking | none | Claude | CLAIMED |
| SEA-11 | Wave impact: slamming, green water | stand-in | Claude | CLAIMED |
| SEA-12 | Hydrodynamic loads on arbitrary bodies | none | Claude | CLAIMED |
| SEA-13 | Whitewater, foam, bubbles, spray generation | stand-in | Claude | LANDED e9007d3bb |
| SEA-14 | Water entry and exit | stand-in | Claude | LANDED 12b84154b |
| SEA-15 | Tracers and slicks in water | stand-in | Claude | LANDED ccbc86285 |
| FLUID-03 | FLIP and APIC grid-particle liquids | none | Claude | CLAIMED |
| HYDRO-01 | Conservative shallow water | partial | Claude | LANDED 9a189c4eb |
| ATMO-01 | Boundary-layer wind field | stand-in | Claude | LANDED c38c25d3d |
| ATMO-02 | Atmospheric turbulence and gusts | stand-in | Claude | LANDED c38c25d3d |
| ATMO-03 | Moist convection and cloud dynamics | none | Claude | LANDED 8833dbf0c |
| ATMO-04 | Precipitation microphysics | stand-in | Claude | LANDED acbc53c7e |
