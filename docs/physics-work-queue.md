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

Never take or edit a row owned by someone else. One claim at a time per agent, at most three open claims per tool.

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

- (none yet)

## Open

| ID | Solver | State today | Owner | Status |
| --- | --- | --- | --- | --- |
| DYN-08 | Large-scale GPU rigid dynamics | none | Open | OPEN |
| SOFT-04 | Volumetric solids (FEM) | partial | Open | OPEN |
| SOFT-06 | Pressure bodies | none | Open | OPEN |
| BREAK-04 | Exterior ballistics | partial | Open | OPEN |
| BREAK-05 | Terminal ballistics and impact damage | stand-in | Open | OPEN |
| LIFE-02 | Limbless, insect and small-animal locomotion | none | Open | OPEN |
| LIFE-07 | Machine dynamics with actuators | stand-in | Open | OPEN |
| AERO-04 | Turbomachines in flow | none | Open | OPEN |
| AERO-05 | Falling and tumbling light bodies | none | Open | OPEN |
| SEA-03 | Nonlinear waves, rogue waves | none | Open | OPEN |
| SEA-05 | Nearshore waves and surf zone | partial | Open | OPEN |
| SEA-06 | Tsunami and impulse waves | none | Open | OPEN |
| SEA-07 | Tides, storm surge and currents | none | Open | OPEN |
| FLUID-05 | Compressible flow, shock and blast | none | Open | OPEN |
| FLUID-06 | Viscoplastic fluids at small scale | partial | Open | OPEN |
| FLUID-07 | Thin films and droplets on surfaces | stand-in | Open | OPEN |
| HYDRO-02 | Rainfall-runoff and infiltration | stand-in | Open | OPEN |
| HYDRO-04 | Landscape evolution | stand-in | Open | OPEN |
| HYDRO-05 | Dam and levee breach | stand-in | Open | OPEN |
| HYDRO-06 | Groundwater and springs | none | Open | OPEN |
| ATMO-05 | Tropical cyclones and large vortices | partial | Open | OPEN |
| ATMO-06 | Airborne particle transport | stand-in | Open | OPEN |
| ATMO-07 | Lightning and atmospheric electricity | none | Open | OPEN |
| ATMO-08 | Fog and cold-air drainage | stand-in | Open | OPEN |
| ATMO-09 | Surface energy balance | partial | Open | OPEN |
| EARTH-03 | Particle-laden gravity currents | partial | Open | OPEN |
| EARTH-05 | Terramechanics | stand-in | Open | OPEN |
| EARTH-06 | Impact and explosion cratering | stand-in | Open | OPEN |
| EARTH-07 | Aeolian transport | stand-in | Open | OPEN |
| EARTH-08 | Seismic waves and ground shaking | none | Open | OPEN |
| EARTH-09 | Volcanic eruption column | partial | Open | OPEN |
| EARTH-10 | Lava flow | partial | Open | OPEN |
| ICE-01 | Snowpack | partial | Open | OPEN |
| ICE-02 | Glacier and ice-sheet flow | none | Open | OPEN |
| ICE-03 | Iceberg rigid-body dynamics and calving | stand-in | Open | OPEN |
| ICE-04 | Pack ice and floes | stand-in | Open | OPEN |
| ICE-05 | Ice thermodynamics | none | Open | OPEN |
| FIRE-04 | Explosive blast loading | none | Open | OPEN |
| FIRE-05 | Explosive source and fragments | stand-in | Open | OPEN |
| FIRE-06 | Heat conduction and phase change | none | Open | OPEN |
| FIRE-07 | Burning of structures, ships and solids | stand-in | Open | OPEN |
| SOUND-01 | Outdoor propagation | stand-in | Open | OPEN |
| SOUND-02 | Enclosed and urban acoustics | partial | Open | OPEN |
| SOUND-03 | Underwater acoustics | none | Open | OPEN |
| SOUND-04 | Contact and modal sound | none | Open | OPEN |
| SOUND-05 | Physics-driven fluid, fire, wind and machine sound | none | Open | OPEN |
| BIO-02 | Plant growth and morphogenesis | none | Open | OPEN |
| BIO-03 | Forest ecosystem dynamics | sound | Open | OPEN |
| BIO-04 | Material ageing | none | Open | OPEN |
| SPACE-01 | N-body and orbital dynamics | partial | Open | OPEN |
| SPACE-02 | Celestial ephemeris and rotation | partial | Open | OPEN |
| SPACE-03 | Accretion disks and motion near compact objects | none | Open | OPEN |

## Taken

Claimed by Claude: being built now or queued next, film-first. Do not start these.

| ID | Solver | State today | Owner | Status |
| --- | --- | --- | --- | --- |
| DYN-01 | 3D rigid body and contact | sound | Claude | CLAIMED |
| DYN-02 | 2D rigid body | sound | Claude | CLAIMED |
| DYN-03 | Articulated bodies, joints, motors, robots | partial | Claude | CLAIMED |
| DYN-04 | Wheeled vehicles on roads | partial | Claude | CLAIMED |
| DYN-05 | Rail vehicle dynamics | none | Claude | CLAIMED |
| DYN-06 | Mass properties and collision geometry | partial | Claude | CLAIMED |
| DYN-07 | Dynamic character, balance, push response | partial | Claude | CLAIMED |
| SOFT-01 | Cloth and thin shells | partial | Claude | CLAIMED |
| SOFT-02 | Rods, ropes, cables, chains (Cosserat) | partial | Claude | CLAIMED |
| SOFT-03 | Hair, fur, mane, tail, feathers, spring bones | stand-in | Claude | CLAIMED |
| SOFT-05 | Muscle, fat and skin soft tissue | none | Claude | CLAIMED |
| BREAK-01 | Brittle and ductile fracture, destruction | stand-in | Claude | CLAIMED |
| BREAK-02 | Structural collapse and load path | stand-in | Claude | CLAIMED |
| BREAK-03 | Ductile crushing: hulls, car bodies, rail cars | none | Claude | CLAIMED |
| LIFE-01 | Legged animal locomotion (quadrupeds, bipeds) | stand-in | Claude | CLAIMED |
| LIFE-03 | Aquatic locomotion | none | Claude | CLAIMED |
| LIFE-04 | Collective animal motion | stand-in | Claude | CLAIMED |
| LIFE-05 | Pedestrian and dense-crowd dynamics | partial | Claude | CLAIMED |
| LIFE-06 | Mass formations and cavalry charge | stand-in | Claude | CLAIMED |
| AERO-01 | Aerodynamic loads on bodies | stand-in | Claude | CLAIMED |
| AERO-02 | Membrane aerodynamics (FSI) | none | Claude | CLAIMED |
| AERO-03 | Flight dynamics (wings, rotors, bodies) | none | Claude | CLAIMED |
| SEA-01 | Wave spectrum and wave-field evolution | stand-in | Claude | CLAIMED |
| SEA-02 | Ocean surface synthesis and query | partial | Claude | CLAIMED |
| SEA-04 | Local dispersive free surface | stand-in | Claude | CLAIMED |
| SEA-08 | Ship seakeeping | stand-in | Claude | CLAIMED |
| SEA-09 | Manoeuvring, propulsion, resistance, sailing hull | none | Claude | CLAIMED |
| SEA-10 | Damage, flooding, capsize, sinking | none | Claude | CLAIMED |
| SEA-11 | Wave impact: slamming, green water | stand-in | Claude | CLAIMED |
| SEA-12 | Hydrodynamic loads on arbitrary bodies | none | Claude | CLAIMED |
| SEA-13 | Whitewater, foam, bubbles, spray generation | stand-in | Claude | CLAIMED |
| SEA-14 | Water entry and exit | stand-in | Claude | CLAIMED |
| SEA-15 | Tracers and slicks in water | stand-in | Claude | CLAIMED |
| FLUID-01 | SPH, divergence-free (accurate mode) | none | Claude | CLAIMED |
| FLUID-02 | Position based fluids (fast mode) | none | Claude | CLAIMED |
| FLUID-03 | FLIP and APIC grid-particle liquids | none | Claude | CLAIMED |
| FLUID-04 | Eulerian smoke and gas | stand-in | Claude | CLAIMED |
| HYDRO-01 | Conservative shallow water | partial | Claude | CLAIMED |
| HYDRO-03 | Sediment transport and channel morphodynamics | stand-in | Claude | CLAIMED |
| ATMO-01 | Boundary-layer wind field | stand-in | Claude | CLAIMED |
| ATMO-02 | Atmospheric turbulence and gusts | stand-in | Claude | CLAIMED |
| ATMO-03 | Moist convection and cloud dynamics | none | Claude | CLAIMED |
| ATMO-04 | Precipitation microphysics | stand-in | Claude | CLAIMED |
| ATMO-10 | Synoptic weather and moisture transport | stand-in | Claude | CLAIMED |
| EARTH-01 | MPM continuum | stand-in | Claude | CLAIMED |
| EARTH-02 | Depth-averaged granular flow | partial | Claude | CLAIMED |
| EARTH-04 | Discrete-element rubble and boulders | partial | Claude | CLAIMED |
| FIRE-01 | Wildfire spread | partial | Claude | CLAIMED |
| FIRE-02 | Flame and fireball | stand-in | Claude | CLAIMED |
| FIRE-03 | Integral plume and thermal model | partial | Claude | CLAIMED |
| BIO-01 | Plant mechanics under wind and water | stand-in | Claude | CLAIMED |
