# Physics solver catalog

Every physical phenomenon Margo's films and scenes need, as one solver each, built on the framework in
[physics-framework.md](physics-framework.md). The defects that started this work are in
[physics-audit.md](physics-audit.md); rigid-body parity with Rapier is tracked in [rapier-parity.md](rapier-parity.md).

The catalog covers all 110 packages under `packages/`, the audit (PA-01 to PA-92 and its solver plan) and the Rapier
parity file. "State" is judged from each package's source headers, file lists and the audit, not from a line-by-line
read of every function.

**How to read it.** Each solver has an ID (family and number), the phenomenon and model, the packages that hold or
will hold it, its state today, the best published methods to build from, and the shared kernels it uses. The
coupling matrix in section 3 lists every pair of solvers that exchange data, and which way.

**Who builds what.** [physics-work-queue.md](physics-work-queue.md) lists each solver's owner and status, and how to claim an open one.

**Citations.** Each solver's owner checks every citation (title, authors, year, venue) against the paper itself
before building, per the research-first rule, and records the checked list in the package docs. A citation here is
a starting point, not a verified reference.

## 0. Scope and conventions

**Packages with no physical phenomenon, and so no solver.** They are pure rendering, tooling, formats, UI or data:
- Rendering and display: core, stage, shader, materials, post, taa, dof, oit, tonemap, toon, shadows, clustered, lightmap, lighting2d, environment (IBL and lighting parts), voxel-pathtracer, splats, points, lines, text, ui, sprites, pixel, transitions, culling, lod, selection, inspector, stats, quality, viewcube, labels, html, cameras, controls (camera parts).
- Assets and formats: loaders, decoders, exporters, gltf, usdz, fbx, brep, cad, ifc, tiles, cache, save, geometry, mesh-edit, splines, road, wfc, tilemap, blender, kit-*, margoengine, react, worker, headless, webgl2-compat, xr (the physics part is PA-82), mcp, video, input, netcode (PA-89), ecs, fsm, tween, math, scene, compute (it supplies kernels), bvh (it supplies kernels).
- Physical appearance that follows from a solver and is not a solver itself: sky and aurora optics, caustics, underwater optics, material lobes.

**Packages that carry or need physics.** physics, physics2d, ragdoll, voxel, voxel-edit, kinematics-constraints, robot-planning, machinery, rigging, animator, animation, humans, horses, armies, navmesh, behavior, water, weather, sky, vfx, creative, scatter, scenes, terrain, biomes, procedural, audio, mixer, sciviz, cutscene, cinematic, environment (fog volumes), game.

**State vocabulary.**
- none: nothing exists.
- stand-in: a scripted or kinematic substitute exists. This is the audit's recurring pattern.
- partial: a real model exists but it is incomplete or uncoupled.
- sound: a deterministic, source-cited model with tests.

**Shared kernels K01 to K05.** These are the framework layer and every solver uses them, so the table lists only K06 and above.

## 1. Solver table

The first column is the ID. Paths are relative to `packages/`. The last column lists the extra kernels beyond K01 to K05.

### Family DYN: rigid, articulated and contact dynamics (8)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| DYN-01 | 3D rigid body and contact | Newton-Euler, friction, restitution, CCD, joints, queries | physics/src/physics.ts, physics/kernel/src/*.rs, voxel/src/physics.ts, ragdoll | sound: Rapier parity rows 234 DONE, 10 PARTIAL, 4 MISSING of 254 (2026-11-26). Gaps are PA-01, 02, 05, 06, 36 and 88. | Macklin et al., "Small Steps in Physics Simulation" (SCA 2019). Tonge et al., "Mass splitting for jitter-free parallel rigid body simulation" (2012). Catto, Solver2D soft step (2024). | K06 K07 K08 K09 |
| DYN-02 | 2D rigid body | Same model in 2D | physics2d, tilemap colliders, sprites | sound (docs/rapier-parity-2d.md) | Catto, Box2D v3 soft step (2024) | K06 K08 K09 |
| DYN-03 | Articulated bodies, joints, motors, robots | Featherstone ABA/RNEA, joint limits and motors, gears, pulleys, TOPP | physics/kernel/src/multibody.rs; machinery/src/kinematics.ts; robot-planning/src/*; kinematics-constraints | partial. Kernel is sound (X-66, X-67). Machinery is a stand-in (PA-80). Robot planning is geometric only (PA-81). | Featherstone, *Rigid Body Dynamics Algorithms* (2008). Baraff, "Linear-time dynamics using Lagrange multipliers" (1996). Pham and Pham, "Time-optimal path parameterization based on reachability analysis" (2018). | K09 K10 K29 |
| DYN-04 | Wheeled vehicles on roads | Tyre forces from a full tyre model: Pacejka's 2012 Magic Formula (MF 6.x) with the combined-slip weighting functions (Gxα, Gyκ), load sensitivity, inflation-pressure sensitivity, camber on lateral force and aligning moment, aligning moment from pneumatic trail and residual torque, rolling resistance, and relaxation length (first-order transient slip, load-dependent lengths) so forces build up over distance rolled; suspension, drivetrain, tracks, motorcycle, horse-drawn carts; road surfaces as colliders with per-surface grip (dry and wet asphalt, gravel, dirt, cobbles, rain from the weather field) and banking from `road`; a path-following driver that steers along a lane and holds the fastest speed the tyres can carry through each curve | Physics vehicles, tyres, drivetrain, tracks and motorcycles, with `@margoengine/road/driving` for matched road colliders, measured wet grip, compliant soils and lane control. Procedural vehicles can receive mass and live weather wind. | live road/deck, ATMO-09 and weather coupling with drivetrain replay. Persistent soil displacement remains EARTH-05 (PA-45). The tyre is still the 1992 sine Magic Formula with a load-sensitive peak and a friction-ellipse scaling (`physics/src/tyres.ts`), plus a brush model; MF 6.x combined slip, pressure, camber, aligning moment and relaxation length are open (see [physics-solver-audit.md](physics-solver-audit.md)). | Pacejka, *Tyre and Vehicle Dynamics* (3rd ed., 2012), chapter 4 (MF 6.x, combined slip) and chapter 7 (relaxation length, transient slip). Besselink, Schmeitz and Pacejka, "An improved Magic Formula/Swift tyre model that can handle inflation pressure changes" (Vehicle System Dynamics 48, 2010). Svendenius, brush tyre model (2007). Coulter, "Implementation of the pure pursuit path tracking algorithm" (CMU-RI-TR-92-01, 1992). Hoffmann, Tomlin, Montemerlo and Thrun, "Autonomous automobile trajectory tracking for off-road driving" (2007). | K07 K09 K18 |
| DYN-05 | Rail vehicle dynamics | Wheel-rail creep contact, bogies and suspension, couplers and buffers, track geometry (curves, cant, switches), traction and braking, derailment; overhead wire and pantograph: the contact wire as a tensioned cable, pantograph spring uplift, wire sway, contact loss and arcing | `@margoengine/physics/rail` | layout-1 rail cars and cable, live ATMO-09 wetness, signed origins, equal forward/reverse curve side, and native catenary work receipts. V-Track dry lateral contact misses 14 of 19 bands. | Kalker, *Three-Dimensional Elastic Bodies in Rolling Contact* (1990). Polach, "Creep forces in simulations of traction vehicles running on adhesion limit" (2005). Iwnicki, *Handbook of Railway Vehicle Dynamics* (2006). Bruni et al., "The results of the pantograph-catenary interaction benchmark" (Vehicle System Dynamics 2015). Krishnan et al. (2025), V-Track lateral creep measurements. | K07 K09 K18 |
| DYN-06 | Mass properties and collision geometry | Closed-mesh volume and inertia, open-mesh repair, convex decomposition | physics/kernel/src/mesh.rs, mass.rs; physics/src/decomposition.ts, mesh-clean.ts, mesh-fit.ts; blender/src/components.ts | partial: PA-87 (1 kg/m³ boxes), PA-88 (open meshes), PA-09 (`Date.now` bound) | Mirtich, "Fast and accurate computation of polyhedral mass properties" (1996). Jacobson, Kavan and Sorkine-Hornung, "Generalized winding numbers" (2013). Wei et al., CoACD (SIGGRAPH 2022). | K07 K11 K24 |
| DYN-07 | Dynamic character, balance, push response | Upright dynamic body, powered ragdoll, get-up, foot contact, physics-driven walking; hands that grasp: finger wrap, grip force and friction closure on ladder rungs, ropes, rails and tools | physics/src/dynamic-character.ts, character.ts; ragdoll/src/*; animator/src/foot-placement.ts, root-motion.ts; controls/src/walk.ts | partial: X-62 to X-65 done. PA-67, 77, 78 open. Characters never enter the world. | Coros, Beaudoin and van de Panne, "Generalized biped walking control" (2010). Geijtenbeek and Pronost, "Interactive character animation using simulated physics" (2012). Pollard and Zordan, "Physically based grasping control from example" (SCA 2005). | K07 K09 K10 K29 |
| DYN-08 | Large-scale GPU rigid dynamics | 10⁵ to 10⁶ bodies for rubble, debris and avalanches | none (X-73 to X-76 are MISSING) | none | Giles, Diaz and Yuksel, "Augmented Vertex Block Descent" (SIGGRAPH 2025). Macklin et al. (2019). | K06 K08 K09 |

### Family SOFT: deformables (6)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| SOFT-01 | Cloth and thin shells | Stretch, bend, self-collision, friction, tearing (torn pieces become separate cloths with `splitOnTear: 'all'`; along edges, or through faces with `adaptiveTearing`, Pfaff et al. 2014), skinned cloth, garments, flags | physics/src/soft.ts, soft-wasm.ts, gpu-cloth.ts (GPU cloth, 2026-11-27); humans (garments); rigging/src/springs.ts | partial. XPBD cloth is sound on the CPU (Wasm) and on the GPU (`@margoengine/physics/gpu-cloth`). PA-05's soft world is done (snapshots); PA-06 is fixed; PA-29 is open. X-27 (vertex block descent for cloth), X-28 (aerodynamics), X-30 (tethers, CPU and GPU cloth) and X-31 (skinned cloth) are DONE. | Macklin, Müller and Chentanez, "XPBD" (2016). Chen et al., "Vertex Block Descent" (SIGGRAPH 2024). Bridson, Fedkiw and Anderson, "Robust treatment of collisions, contact and friction for cloth animation" (2002). Pfaff et al., "Adaptive tearing and cracking of thin sheets" (2014). | K06 K07 K09 |
| SOFT-02 | Rods, ropes, cables, chains (Cosserat) | Bend and twist, wrapping, friction, anchor chains, rigging, vines | physics/src/rope.ts; physics/src/rod/index.ts; physics/src/soft.ts | partial. Elastic rods (`@margoengine/physics/rod`, 2026-11-26) bend, twist and stretch in a multibody's direct solve, with Morison loads, buoyancy and vortex lift in water, pins and cast-off, checked against the cantilever, catenary, taut-cable frequency and strumming lock-in. Wrapping (X-53), discrete elastic rods (X-52) and X-54, 55 are open. | Bergou et al., "Discrete Elastic Rods" (2008). Kugelstadt and Schömer, "Position and orientation based Cosserat rods" (2016). Sueda, Kaufman and Pai, "Musculotendon simulation for hand animation" (2008) for wrapping. | K06 K09 K24 |
| SOFT-03 | Hair, fur, mane, tail, feathers, spring bones | Strand dynamics against wind and the body | rigging/src/springs.ts; horses/src/model.ts; humans (hair); animation | LANDED in `@margoengine/physics/strands`: direct Cosserat rods, fast inextensible guides, tapered sections, live wind and bed, swept link self-contact, and reciprocal rigid capsule impulses. The optional adapters drive the weighted horse and VRM rigs. The original film bindings are tracked in the demo review. | Bertails et al., "Super-helices for predicting the dynamics of natural hair" (2006). Müller, Kim and Chentanez, "Fast simulation of inextensible hair and fur" (2012). | K06 K09 K18 |
| SOFT-04 | Volumetric solids (FEM) | Rubber, jelly, bending timber, ice sheets, soft flesh; cutting, tearing and fracture into separate bodies, each piece with its own state | `@margoengine/physics/soft` | Stable Neo-Hookean XPBD, linearly implicit FEM, native vertex blocks and local/global Projective Dynamics. Vertex blocks offer orthotropic elasticity, independent material-axis tear limits and progressive fracture-energy softening. Plane and finite cuts slice through cells and preserve mass, rest volume and linear momentum. Internal incisions have independent lips and preserve connectivity at the front. Authored seams and unseeded principal-strain cracks can open through cells. Straight isotropic fronts support separate opening, sliding and tearing toughness. Dedicated GPU compute, orthotropic or kinked mixed-mode propagation, and the complete production binding remain open. | Smith, de Goes and Kim, "Stable Neo-Hookean Flesh Simulation" (2018). Bouaziz et al., "Projective Dynamics" (2014). Chen et al., "Vertex Block Descent" (2024). Senalik and Farber, [Mechanical Properties of Wood](https://research.fs.usda.gov/treesearch/62244) (2021). Molino, Bao and Fedkiw, [A Virtual Node Algorithm for Changing Mesh Topology During Simulation](https://physbam.stanford.edu/papers/stanford2004-01.pdf) (2004). Areias and Rabczuk, [Steiner-point free edge cutting of tetrahedral meshes with applications in fracture](https://doi.org/10.1016/j.finel.2017.05.001) (2017). | K09 K11 K12 K19 K24 |
| SOFT-05 | Muscle, fat and skin soft tissue | Animals and humans, skin sliding, secondary motion | rigging/src/correctives.ts, autorig.ts; animation; humans; horses | none (shape-only correctives) | Teran et al., "Robust quasistatic finite elements and flesh simulation" (2005). Lee, Sifakis and Terzopoulos, "Comprehensive biomechanical modeling of the upper body" (2009). Smith et al. (2018). | K09 K10 K19 K24 |
| SOFT-06 | Pressure bodies | Balloons, inflatables, tyres, filled sails, airbags. Punctures, tears and bursts: a breached shell vents its gas through the opening (orifice flow), loses pressure at the measured rate and collapses, and a shell torn apart becomes separate bodies, each keeping its own share of gas or none (a popped balloon, a split airbag, a ripped sail). Volumetric cutting and cloth tearing into separate bodies already exist in `physics/src/soft-split.ts` (virtual nodes) and `SoftBodies.cut`, but a torn pressure shell does not vent: in one piece it keeps all its gas, split apart it loses it at once (see [physics-solver-audit.md](physics-solver-audit.md)) | `@margoengine/physics/soft` | Isothermal gas in closed triangle shells, variable fill and ambient pressure, with the existing soft and rigid contact. | Müller et al., "Position based dynamics" (2007). Macklin et al., "Unified particle physics" (2014). Matyka and Ollila (2003). Wang and Nefske, "A new CAL3D airbag inflation model" (SAE 880654, 1988) for orifice venting. | K09 K11 |

### Family BREAK: fracture, structures and impact (5)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| BREAK-01 | Brittle and ductile fracture, destruction | Pre-fracture, runtime fracture, damage from impulse, per-material strength, settled rubble | voxel/src/debris.ts, physics.ts, blocks.ts; procedural/src/voronoi.ts; vfx/src/debris.ts | physics/breakable (b63a217ba): convex rigid fracture, pre-fractured or at the hit, bond graph with anchors, contact and blast damage, debris policy. X-40, X-43 DONE; X-41, X-42 PARTIAL. Stand-ins left: PA-40, 41, 44 (voxel), PA-50 (vfx ejecta). | Müller, Chentanez and Kim, "Real time dynamic fracture with volumetric approximate convex decompositions" (2013). O'Brien and Hodgins (1999). Wolper et al., CD-MPM (2019) for the high-fidelity mode. | K09 K11 K15 K28 |
| BREAK-02 | Structural collapse and load path | Masonry, timber, steel frames, bridges, masts, chimneys, walls; wind and blast loads on structures | voxel/src/debris.ts (flood-fill stand-in); scenes/src/fauld-tunnels.ts; procedural/src/buildings.ts | stand-in: PA-40 (a floating slab). PA-31 adds wind-load failure. | Whiting et al., "Procedural modeling of structurally-sound masonry buildings" (2009). Tagel-Din and Meguro, applied element method (2000). Livesley, rigid-block limit analysis (1978). | K09 K12 K19 K28 |
| BREAK-03 | Ductile crushing: hulls, car bodies, rail cars | Plating and frame energy absorption in ship collisions, grounding and ramming; crumple zones in road and rail crashes | `@margoengine/physics/crush` resolves measured normal force–stroke curves with rigid recoil and seal loss, including held-out model-ship compression, passenger-rail compression, and a full-width NCAP road-car pulse. `CrushShellSolver` advances distributed sheets with bending, plane-stress plasticity, reciprocal multi-point sphere contact and cohesive joints. Optional native workers process membrane and pressure faces with deterministic face-order assembly. SEA-10 floods through the live seam polygon and returns hydrostatic pressure to a fixed hull's shell. | Arbitrary-shape shell contact, automatic tearing, moving hull attachments and the other PA-52 paths remain open. | Minorsky, "An analysis of ship collisions" (1959). Pedersen and Zhang, "On impact mechanics in ship collisions" (1998). Kamal, "Analysis and simulation of vehicle to barrier impact" (SAE 700414, 1970). Huang, *Vehicle Crash Mechanics* (2002). [Shell research](whitepaper/reproduce.md#break-03-distributed-ductile-shell) | K09 K11 K19 |
| BREAK-04 | Exterior ballistics | Shot, shell, arrow, bullet and fragment flight: Mach-dependent drag, Magnus force, wind, spin | vfx/src/gunfire.ts (`sphereDrag`), vfx/src/debris.ts | partial: PA-62 (debris uses a constant Cd) | McCoy, *Modern Exterior Ballistics* (1999). Hoerner, *Fluid-Dynamic Drag* (1965). | K18 K23 |
| BREAK-05 | Terminal ballistics and impact damage | Penetration, ricochet, splintering, wood, iron, stone, bodies | vfx/src/gunfire.ts; voxel/src/physics.ts | stand-in: PA-52, 53 (including the shared splinter emitter bug) | Recht and Ipson (1963). Backman and Goldsmith, "The mechanics of penetration of projectiles into targets" (1978). Zukas, *Impact Dynamics* (1982). | K07 K09 K23 |

### Family LIFE: characters, animals, crowds and machines (7)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| LIFE-01 | Legged animal locomotion (quadrupeds, bipeds) | Point mass with leg spring, grip-limited turning, lean, slopes, slips, falls | @margoengine/physics/legged and @margoengine/horses | signed terrain and reciprocal deck, accepted gait and pose, optional native body partitions | Alexander and Jayes, "A dynamic similarity hypothesis for the gaits of quadrupedal mammals" (1983). Blickhan, "The spring-mass model for running and hopping" (1989). Geijtenbeek, van de Panne and van der Stappen, "Flexible muscle-based locomotion for bipedal creatures" (2013). | K09 K10 K18 K29 |
| LIFE-02 | Limbless, insect and small-animal locomotion | Snakes, lizards, crabs, spiders, insects, kinematic templates plus ground contact | @margoengine/physics/locomotion | GroundLocomotion with native body partitions, signed TerrainBed, pose and contact wrench ports, and a live slithering scene | Hu, Nirody, Scott and Shelley, "The mechanics of slithering locomotion" (2009). Holmes et al., "The dynamics of legged locomotion" (2006). | K09 K10 K29 |
| LIFE-03 | Aquatic locomotion | Fish, whales, dolphins, seals, undulatory swimming, breaching, diving | physics/src/life | six-DOF SIMD swimmer with optional native workers, a body-length feedback limit, live SEA-02 and LIFE-04 coupling, and signed contact and wake fields | Lighthill, "Note on the swimming of slender fish" (1960). Triantafyllou, Triantafyllou and Yue, "Hydrodynamics of fishlike swimming" (2000). Tu and Terzopoulos, "Artificial fishes" (1994). | K09 K10 K22 K29 |
| LIFE-04 | Collective animal motion | Flocks, schools, herds, swarms | `@margoengine/physics/schooling`, `behavior/src/steering.ts` | sound: three-zone metric rules, nearest-visible neighbour count, predator prediction and point-mass mass, drag and turn limits. Intent is tested with a body-controller stand-in. | Reynolds, "Flocks, herds and schools" (1987). Couzin et al. (2002). Ballerini et al., topological interaction in starlings (2008). | K06 K18 |
| LIFE-05 | Pedestrian and dense-crowd dynamics | Social force, contact forces, crush, walls, doorways | physics/src/pedestrians, navmesh/src/crowd.ts and orca.ts | Mass-weighted ORCA, real route and grade, force-driven ellipses, shoulder and wall loads, anticipatory braking, signed ground projection and optional native drive and wall phases. Declared force and kinematics ports for DYN-07 and BREAK-05. | Helbing, Farkas and Vicsek, "Simulating dynamical features of escape panic" (2000). Karamouzas, Skinner and Guy, "Universal power law governing pedestrian interactions" (2014). Narain et al., "Aggregate dynamics for dense crowd simulation" (2009). | K06 K09 |
| LIFE-06 | Mass formations and cavalry charge | Momentum, impact, knock-down, ragdoll hand-off, riders | navmesh/src/formations.ts; armies/src/*; horses/src/seat.ts | stand-in: PA-72, 73 (masses of 500 and 80, velocity changes instantly) | Helbing and Molnár (1995). Helbing et al. (2000). Rider mass model: Bystroem et al. (2009), Münz et al. (2014) (the audit's sources). | K06 K07 K09 |
| LIFE-07 | Machine dynamics with actuators | Engines, steam, hydraulics, cranes, trebuchets, clockwork, windlasses, capstans; tracking drives: a telescope and its dome slaved together, solar trackers with backtracking and wind stow, motor ramps and control loops | machinery/src/*; procedural/src/gears.ts; physics/src/mechanisms.ts | stand-in: PA-80 (kinematic ratios, no torque or load) | Featherstone (2008). Merritt, *Hydraulic Control Systems* (1967). Lorenzo, Narvarte and Muñoz, "Tracking and back-tracking" (Progress in Photovoltaics 2011). | K09 K10 K18 |

### Family AERO: aerodynamics and flight (5)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| AERO-01 | Aerodynamic loads on bodies | Drag, lift and moment from shape and relative wind, with sheltering | physics WindForce and flight/air solver | signed-cell surface traction with native SIMD and a supported paper-mobile fixture. Shelter and round-body drag remain open (PA-26). | Hoerner, *Fluid-Dynamic Drag* (1965) and *Fluid-Dynamic Lift* (1975). Katz and Plotkin, *Low-Speed Aerodynamics* (2001). | K07 K11 K22 |
| AERO-02 | Membrane aerodynamics (FSI) | Sails, flags, parachutes, tents, capes: per-triangle pressure, thrust reacting on the hull | physics/src/soft.ts; rigging/src/springs.ts; horses (tail, mane) | none: PA-29 | Fossati, *Aero-Hydrodynamics and the Performance of Sailing Yachts* (2009). Wilson et al. (2014), the audit's source. Baraff and Witkin (1998). | K09 K22 |
| AERO-03 | Flight dynamics (wings, rotors, bodies) | Aircraft, gliders, birds, bats, insects, balloons, airships, rockets in air | procedural/src/flyer.ts; navmesh/src/volume.ts (kinematic only) | none | Prandtl, lifting line (1918), as in Phillips, *Mechanics of Flight* (2010). Dickinson, Lehmann and Sane, "Wing rotation and the aerodynamic basis of insect flight" (1999). Wu and Popović, "Realistic modeling of bird flight animations" (2003). Pennycuick, *Modelling the Flying Bird* (2008). | K10 K18 K22 |
| AERO-04 | Turbomachines in flow | Windmills, wind turbines, waterwheels, paddles, propellers, with wakes; internal turbomachinery: flow through compressor and turbine blade rows (meanline and through-flow models), combustor, and the exhaust jet with its shear-layer mixing | procedural/src/gears.ts (geometry only) | none | Glauert, blade-element-momentum theory (1935), in Hansen, *Aerodynamics of Wind Turbines* (2015). Dixon and Hall, *Fluid Mechanics and Thermodynamics of Turbomachinery* (2014). | K18 K22 |
| AERO-05 | Falling and tumbling light bodies | Rigid leaves, paper, ash flakes, snowflakes and feathers, winged seeds, rounded grains and hail | `@margoengine/physics/falling` APW plate motion, blade-element autorotation, quadratic grains and swept rigid boundaries. `@margoengine/weather/hail-physics` supplies size-resolved hail and world-stepped rendering. | native mixed-body rows, physical hail sweeps and a live fixed-axis samara scene (PA-32) | Andersen, Pesavento and Wang (2005), falling-card transitions and unsteady aerodynamics. Rezgui, Hernández Arroyo and Theunissen (2020), samara blade strips. Heymsfield and Wright (2014), terminal hail speeds. | K01 K03 K09 K18 K22 K23 |

### Family SEA: ocean, ships and marine (15)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| SEA-01 | Wave spectrum and wave-field evolution | Wind-sea growth by fetch and duration, swell propagation and decay, refraction, finite-depth dispersion | physics/waves, water/src/sea-state.ts, weather/src/wind.ts | Accepted directional spectrum, native spatial sweeps, and an exact live swell cutaway. Full production binding remains PA-16. | WAMDI Group, "The WAM model" (1988). Booij, Ris and Holthuijsen, SWAN (1999). Hasselmann et al., JONSWAP (1973). | K17 K25 |
| SEA-02 | Ocean surface synthesis and query | FFT and Gerstner surface with choppy displacement; pure synchronous `seaSurface(x, z, t)` returning height, normal and velocity | water/src/fft.ts, fft-shaders.ts, swell-wgsl.ts, query.ts | partial: PA-11 (async GPU readback only), PA-16 (`FFTOcean` has no `setWind`) | Tessendorf, "Simulating Ocean Water" (2001). Horvath, "Empirical directional wave spectra for computer graphics" (2015). | K17 K25 |
| SEA-03 | Nonlinear waves, rogue waves | High-order spectral method, Benjamin-Feir instability, steep Stokes waves | physics/src/rogue (`NonlinearSea`, a `SeaSurface`) | second-order random sea (2026-11-26): Dalzell's sum and difference kernels over equal-variance components, the ECMWF freak-wave statistics (BFI, R, kurtosis, crest and height laws, the expected largest wave), rogue waves as constrained NewWaves placed or drawn at the rate focusing adds. Exact optional workers sum the same pairs with SIMD. High-order spectral evolution remains open | Dommermuth and Yue, "A high-order spectral method for the study of nonlinear gravity waves" (1987). Dysthe (1979). | K17 K25 |
| SEA-04 | Local dispersive free surface | Wakes, rain rings, capillary waves, object drops, harbour waves; hull displacement writes into the surface; reflection and clapotis against quay walls, hulls and breakwaters | water/src/ripples.ts, ships.ts (`ShipWakes`), splash.ts | linear dispersive pressure and volume wake, capillary/current modes, prescribed hull boundaries, rain pulses, native FFT and foam link. Measured advancing stem, apparent angle and drop-collapse timing remain open (PA-13, PA-23). | Jeschke et al., "Water Surface Wavelets" (SIGGRAPH 2018). Yuksel, House and Keyser, "Wave particles" (2007). Madsen and Sørensen, Boussinesq (1992). | K12 K25 |
| SEA-05 | Nearshore waves and surf zone | Shoaling, refraction, breaking, wave set-up, undertow, longshore and rip currents, run-up, overtopping; swash, the wet-sand line and swash marks left after run-up | physics/src/surf (`SurfSolver`, on HYDRO-01); water/src/surf.ts, breaker.ts, coastal.ts (drawing) | framework solver (2026-11-26): the surfbeat chain on the shallow water: shoaling, refraction, breaking, roller, set-up, undertow, longshore and rip currents, surf beat, run-up and the wet sand. The optional radiation-stress workers preserve scalar forcing and the run-up record drives a live wet-sand cutaway. Overtopping is the shallow water's. | Longuet-Higgins and Stewart, radiation stress (1964). Battjes and Janssen (1978). Roelvink et al., XBeach (2009). | K12 K14 K25 |
| SEA-06 | Tsunami and impulse waves | Fault or slide source, long-wave travel, inundation | `@margoengine/physics/tsunami` | Conservative wet/dry long waves, bottom response, natural source field and eikonal arrivals. Already consumes ICE-02 → ICE-03 and TerrainBed. | Okada, "Surface deformation due to shear and tensile faults" (1985). LeVeque, George and Berger, GeoClaw (2011). Heller and Hager, "Impulse product parameter in landslide generated impulse waves" (2010). | K12 K14 K20 |
| SEA-07 | Tides, storm surge and currents | Barotropic shallow water on an ocean grid with tidal potential, wind stress, inverse barometer, tidal races | physics/src/surge (`SurgeSolver` over HYDRO-01's `ShallowWaterSolver`); sky/src/hurricane.ts (profile only) | framework solver (2026-11-26): the inverse barometer and the equilibrium tide of the world's Sun and Moon as one forcing potential in the water's hydrostatic reconstruction, the wind's stress, the Coriolis force, open-sea tides from harmonic constituents, and a time scale for hours of surge in seconds. Optional native workers preserve the scalar head and accepted replay. Tidal races are the shallow water's currents through narrows | Jelesnianski et al., SLOSH (1992). Luettich et al., ADCIRC (1992). Pugh and Woodworth, *Sea-Level Science* (2014). | K12 K14 |
| SEA-08 | Ship seakeeping | 6-DOF hull on waves: hydrostatics over the wetted mesh, Froude-Krylov, diffraction, radiation memory, wave drift, green water | physics/src/seakeeping/ (`HullSolver`), optional near-steady heave and pitch course loads | Guarded signed-cell loads, optional native panel workers, and fixed-camera hull and wake proof. Original film timelines and broader validation remain open | Cummins, "The impulse response function and ship motions" (1962). Salvesen, Tuck and Faltinsen, "Ship motions and sea loads" (1970). Fossen, *Handbook of Marine Craft Hydrodynamics* (2011). Kerner, "Water interaction model for boats in video games" (2015). | K10 K11 K18 K22 |
| SEA-09 | Manoeuvring, propulsion, resistance, sailing hull | Thrust, rudder, turning circle, heel, squat, leeway, keel lift, oars, planing | physics/src/ship (`ShipSolver` on rigid bodies; water/src/ships.ts is the caller path) | framework solver (2026-11-26, rebuilt 2026-11-27): MMG manoeuvring with propeller, race and rudder, and a fourth degree of freedom, heel (Fukui et al. 2016); Holtrop and Mennen resistance; squat on the sea; shallow water (Ankudinov et al. 1990, or a hull's measured table, KVLCC2's); banks (Vantorre et al. 2003); waves' mean drift and added resistance; level ice; a four-quadrant B-series propeller; bow thruster, quay suction, wake sources and the race's boil; autopilot and track following; and, built: a sailing yacht's leeway, heel and keel lift with its sails (`SailingSolver`, a VPP), oars (`RowingSolver`) and planing (`PlaningSolver`, steady and dynamic) | Yasukawa and Yoshimura, MMG standard method (2015). Fukui et al., 4-DOF MMG (2016). Holtrop and Mennen (1982). Ankudinov et al. (1990). Vantorre et al. (2003). Liu and Papanikolaou, ITTC SNNM (2021). Riska et al. (1997). Roddy, Hess and Faller, four-quadrant B-series (2007). Isherwood (1972). Keuning and Katgert, Delft series (2008); ORC VPP (2023). Caplan and Gardner, oar blade model (2007). Savitsky (1964); Zarnick (1978); Garme's transom function as Ghadimi et al. (2019) reprint it. | K18 K22 |
| SEA-10 | Damage, flooding, capsize, sinking | Compartment and progressive flooding, free-surface effect, stability curves | `@margoengine/physics/seakeeping`: `Flooding` and `HullSolver` advance compartment water, trapped or vented air and cargo. Flood mass and attitude couple to the rigid hull. Crush and live shell apertures can open the hull. | PA-10 and the flooding part of PA-52 have scoped tests. Measured case accuracy, full capsize, PA-58 fire damage and remaining vessel events are open. [Evidence and limits](limits.md#progressive-flooding-evidence-and-limits-sea-10) | Ruponen, "Progressive flooding of a damaged passenger ship" (2007). Biran and López Pulido, *Ship Hydrostatics and Stability* (2014). | K11 K22 K28 |
| SEA-11 | Wave impact: slamming, green water | Wagner strip impact and shallow-water deck inundation | physics/src/seakeeping (`HullSolver`, native `bakeHullSlamming`, accepted deck surface and inflow); Water fixed-camera proof | Wedge theory and live tapered-deck replay. 1/12 held-out force markers inside the measured comparison envelope. Original shots remain open | Wagner (1932); von Kármán (1929); Hulin et al. (2022); Audusse et al. (2004); Tveitnes et al. (2008) | K16 K22 |
| SEA-12 | Hydrodynamic loads on arbitrary bodies | Exact submerged-volume buoyancy, added mass, Morison drag, current and flood loads; debris, anchors, animals, bodies in floods | physics/src/loads (`LoadSolver` on rigid bodies, `QuayWall`); water/src/ice.ts (static hydrostatics) | framework solver (2026-11-26): exact local-plane hydrostatics with a righting moment for boxes, meshes and ellipsoids, Froude-Krylov, added mass held implicitly, Morison drag and inertia on members (DNV-RP-C205), drag and windage on compact bodies, vortex shedding, current, race and flood loads; quay wall pressures, run-up and wash. live incident mesh pressure, optional rotational inertia and passive radiation modes, first-impact woody-debris loads and short taut moorings; draft-derived strip or panel radiation, reciprocal projected shallow-water drag for compact bodies and hulls, guided impermeable obstructions, and paddle, wading and swim reaction | Morison et al., "The force exerted by surface waves on piles" (1950). Sarpkaya and Isaacson, *Mechanics of Wave Forces on Offshore Structures* (1981). Haehnel and Daly, "Maximum impact force of woody debris on floodplain structures" (2004). | K07 K11 K22 |
| SEA-13 | Whitewater, foam, bubbles, spray generation | Entrainment, decay, wake foam, whitecap coverage, sea-spray source function; air venting and bubble plumes from a flooding, capsizing or sinking hull | physics/src/foam (`FoamSolver`); water/src/index.ts (`whitecap()`), liquid-whitewater.ts, spray.ts (drawing) | framework solver (2026-11-26): whitecaps from the ST4 spectrum's breaking, foam carried, stretched and gathered into windrows, ship wakes, the spray source function. Air venting from a flooding or sinking hull as a bubble plume and boil (from SEA-10’s `hullBreaches`). Native directional transport and `@margoengine/water/foam-surface` draw the accepted foam field. | Ihmsen et al., "Unified spray, foam and bubbles for particle-based fluids" (2012). Monahan et al., whitecap aerosol (1986). Andreas, "A new sea spray generation function" (1998). | K06 K16 |
| SEA-14 | Water entry and exit | Cavity, crown splash, jets, cannonball, diver, launch, breach | physics/src/entry (`EntrySolver`: slam, impact pressure, cavity and seal, splash events, wake sources, foam); water/src/splash.ts (`ShotSplash`, its `splashes` option) draws them | Native signed-cell profile replay, coded load and pressure checks, and actual splash rendering at 4/8. Independent slam impulses still miss (docs/limits.md, "Water entry and exit"). PA-17 is fixed. | Wagner (1932); Korobkin (2004); Duez et al. (2007); Duclaux et al. (2007); Aristoff et al. (2010); Gekle and Gordillo (2010); docs/clean-room.md "Water entry and exit". | K16 K22 K25 |
| SEA-15 | Tracers and slicks in water | Dye, discoloured water, silt and sediment plumes, oil and fuel slicks: advection and diffusion on the surface and below, carried by currents, waves and a hull's wake, settling by grain size, slick spreading and drift. Sources include cargo leaking from a breached or flooding hold (iron ore turning the water red, coal, grain, oil), at the breach, at the rate the flooding flow carries it out, with colour and settling speed from the cargo material; sources also include fin jets, propeller wash and thruster jets lifting sediment off the bed | `@margoengine/physics/tracers` transports suspended and floating parcels, oil, breach cargo and mobilised grains. Optional native workers calculate the parcel random walk. | Bed ledger, signed-origin flow and the technical ray and ore plume cuts are tested. Independent jet crater accuracy and the original films remain open. [Evidence and limits](limits.md#accepted-parcels-and-independent-jet-scour-sea-15) | Stam, "Stable fluids" (SIGGRAPH 1999) for advection. Fay, "The spread of oil slicks on a calm sea" (1969). van Rijn, *Principles of Sediment Transport in Rivers, Estuaries and Coastal Seas* (1993) for settling. | K13 K14 |

### Family FLUID: general fluid solvers (7)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| FLUID-01 | SPH, divergence-free (accurate mode) | Free-surface liquid, rigid and fluid coupling, surface tension | @margoengine/physics/dfsph | native pressure, viscosity, interfacial energy, rigid reactions and modal load; PA-22, X-56 to X-59 still partial | Bender and Koschier, "Divergence-free SPH for incompressible and viscous fluids" (2017). Akinci et al., rigid-fluid coupling (2012) and surface tension (2013). Weiler et al. (2018); Winchenbach et al. (2020); Probst and Teschner (2025). | K06 K09 K16 |
| FLUID-02 | Position based fluids (fast mode) | Interactive and preview liquids | `@margoengine/physics/pbf`, `@margoengine/water/liquid` | Shared/plain SIMD, two preview profiles, versioned particle fields, live rigid pressure and torque, measured surge release and an in-engine water-surface fixture | Macklin and Müller, "Position based fluids" (2013). Müller, Charypar and Gross (2003). Akinci et al. (2012). Martin and Moyce (1952). | K06 K09 |
| FLUID-03 | FLIP and APIC grid-particle liquids | Large liquid volumes, crashing crests, waterfalls, green water on decks | physics/src/flip (`FlipSolver`: APIC on a MAC grid, ghost-fluid free surface, MIC(0) conjugate gradients; `DeckWaterSolver`: a box riding a hull, `deckInflow` in, `deckClaims` and `bodyForces` out) | sound: the liquid, the deck volume and crests from the sea checked (Martin and Moyce's dam break, the free-surface effect, sloshing, a wave through the box, a held hull's deck load); a crest plunges, its jet against Erinin et al.'s not yet like-for-like (docs/limits.md) | Zhu and Bridson, "Animating sand as a fluid" (2005). Jiang et al., "The affine particle-in-cell method" (2015). Gibou et al. (2002). Martin and Moyce (1952). docs/clean-room.md "Grid-particle liquids". | K12 K13 K15 |
| FLUID-04 | Eulerian smoke and gas | Buoyant flow, vorticity confinement, gunpowder smoke, steam; enclosures with openings: doorway exchange flow, hot gas leaving a kiln, furnace or room, and draughts when a door opens | vfx/src/smoke.ts (prescribed rise) | stand-in: PA-56 | Fedkiw, Stam and Jensen, "Visual simulation of smoke" (2001). Selle et al., "An unconditionally stable MacCormack method" (2008). Zhang, Bridson and Greif (2015). Steckler, Quintiere and Rinkinen, "Flow induced by fire in a compartment" (1982). | K12 K13 |
| FLUID-05 | Compressible flow, shock and blast | Euler equations, muzzle blast, underwater explosions, sonic effects | none | none: PA-49 | Toro, *Riemann Solvers and Numerical Methods for Fluid Dynamics* (2009). Colella and Woodward, PPM (1984). Cole, *Underwater Explosions* (1948). | K14 |
| FLUID-06 | Viscoplastic fluids at small scale | Mud, honey, paint, wet concrete: Bingham and Herschel-Bulkley | `@margoengine/physics/viscoplastic` | Finite-strain 3D APIC, implicit shear return and solvent diffusion, live terrain and replayable inlet. Scene binding and entrainment remain in PA-60. | Ram et al., "A material point method for viscoelastic fluids, foams and sponges" (2015). Huang and Garcia (1998). | K12 K15 K24 |
| FLUID-07 | Thin films and droplets on surfaces | Rain on glass, wet surfaces, drips, puddle filling | `@margoengine/physics/thin-film` | Conservative lubrication, advancing and receding wetting angles, moving receivers, rain impulses and WakeSolver pressure coupling, timed sill release, transient drop flight and render-ready surface geometry. Optional native workers partition the existing film matrix. [Evidence and limits](limits.md#accepted-film-motion-and-independent-incline-drops-fluid-07) | Oron, Davis and Bankoff, "Long-scale evolution of thin liquid films" (1997). Wang, Mucha and Turk, "Water drops on surfaces" (2005). Mori (1990). Beard (1976), Wang and Pruppacher (1977). | K12 K13 |

### Family HYDRO: rivers, floods and hydrology (7)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| HYDRO-01 | Conservative shallow water | Rivers, floods, bores, dam breaks, coastal flow, wet and dry, Manning friction, buildings | physics/src/hydro (`ShallowWaterSolver`, on the terrain bed); water/src/flood.ts, flood-shaders.ts (the GPU flood); water/src/rivers.ts, flow.ts, coastal.ts | framework solver (2026-11-26). `rivers.ts` is still a stand-in (PA-18). The SEA-12 optional path returns guided obstruction pressure and submerged form drag to rigid bodies (PA-19). The GPU flood still has its separate coupling scope. | Kurganov and Petrova (2007). Audusse et al. (2004). Bates, Horritt and Fewtrell, inertial formulation (2010). | K14 |
| HYDRO-02 | Rainfall-runoff and infiltration | Catchment hydrographs, soil moisture, channel routing | `@margoengine/physics/runoff`; Physics hydro inflows, Biomes rivers and disturbance | Integrated Green-Ampt wetting and a TOPMODEL contributing area. Conservative implicit kinematic routing drives HYDRO-01, Biomes river sources and flood-history samples. | Green and Ampt (1911). Beven and Kirkby, TOPMODEL (1979). Lighthill and Whitham, kinematic waves (1955). | K12 K14 K21 |
| HYDRO-03 | Sediment transport and channel morphodynamics | Exner bed update, bedload, suspended load, scour, deposition, meanders, deltas | @margoengine/physics/sediment; water/flood tint | Conservative bedload, Rouse suspension, erosion and deposition, with bank exchange and actual TerrainBed feedback | Meyer-Peter and Müller (1948). van Rijn (1984). Ikeda, Parker and Sawai, "Bend theory of river meanders" (1981). | K12 K14 K21 |
| HYDRO-04 | Landscape evolution | Multidirectional runoff, implicit stream-power incision, uplift, hillslope diffusion and thermal transport | @margoengine/physics/landscape; @margoengine/biomes/landscape | Physical time, sediment classes, shear thresholds and shared TerrainBed changes (PA-39) | Braun and Willett (2013). Cordonnier et al. (2016, 2017). Schott et al. (2023). | K12 K21 |
| HYDRO-05 | Dam and levee breach | Overtopping and piping, breach hydrograph, embankment erosion | scenes/src/fauld-blast.ts (constant-discharge source) | stand-in: PA-19, 60 | Froehlich (1995). Visser (1998). | K14 K21 |
| HYDRO-06 | Groundwater and springs | Unconfined Darcy flow, water table, spring drainage and surface seepage | @margoengine/physics/groundwater | Conservative aquifer storage, native face assembly and registered spring transfer to shallow water | Richards (1931). Harbaugh, MODFLOW-2005 (2005). Rupp and Selker (2006). | K12 |
| HYDRO-07 | Pipe flow, hydraulic structures and hydraulic machines | Closed-conduit flow with Darcy-Weisbach losses (Colebrook, Haaland or Churchill friction), orifices and tank equalisation, Venturi meters, siphons and their vapour limit, steady pipe networks with reservoirs, valves and pumps, lumped water hammer and the hydraulic ram, Pelton jet impulse, hinged bellows displacement, open-channel jumps, critical and normal depth; confined Darcy and Hele-Shaw cells | `@margoengine/physics/hydraulics`; the confined cell solve in `@margoengine/physics/groundwater` | LANDED (2026-11-27): tested against closed forms (docs/limits.md, HYDRO-07); the siphon, canal lock, Venturi meter, hydraulic ram, Pelton wheel, hydraulic jump, Hele-Shaw cell and bellows demos run on it. Functions, not a world solver; no distributed transients | Colebrook (1939). Haaland (1983). Churchill (1977). Todini and Pilati (1988). Joukowsky (1898), Wylie and Streeter (1993). Belanger (1828), Hager, Bremen and Kawagoshi (1990). ISO 5167-4 (2003). Hele-Shaw (1898). | K12 K18 |

### Family ATMO: atmosphere and weather (10)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| ATMO-01 | Boundary-layer wind field | Log-law profile, terrain speed-up and shelter, stability, one shared `sample(x, y, z, t)` | `@margoengine/weather/boundary-layer`, `@margoengine/physics/boundary-layer` | Stable, unstable and neutral surface-layer wind, finite-height Mann gusts and native world fields. Live rigid load and local rain evidence. Terrain and weather-wide feedback remain open. | Dyer (1974). Paulson (1970). Mann (1994). Jackson and Hunt (1975). Sherman (1978). Forthofer et al. (2014). | K12 K13 K17 |
| ATMO-02 | Atmospheric turbulence and gusts | Spectral divergence-free turbulence, travelling gusts | weather/src/turbulence.ts | deterministic Mann FFT and a placed one-cosine front. PA-28 terrain response and near-ground coherence remain open | Mann (1994, 1998). Kaimal et al. (1972). Bridson, Houriham and Nordenstam, "Curl-noise for procedural fluid flow" (2007). | K17 |
| ATMO-03 | Moist convection and cloud dynamics | Potential temperature, vapour, cloud and rain water, latent heat, Kessler microphysics | physics/clouds; environment/density-volume | Boussinesq MAC projection, warm rain and accepted cloud extinction on WebGPU and WebGL2. Terrain lift, cold phases, field validation and the procedural Sky route remain open (PA-34). | Kessler (1969). Klemp and Wilhelmson (1978). Hädrich et al., "Stormscapes" (2020). Harris et al., "Simulation of cloud dynamics on graphics hardware" (2003). | K12 K13 K14 |
| ATMO-04 | Precipitation microphysics | Drop-size distribution, terminal velocity, snow, hail, graupel, melt, rain in mm/h | weather/precipitation; physics/falling; water/wake | partial: size-resolved transport and K23 trajectory, visible SEA-04 capillary rings, PA-23 renderer damping open | Marshall and Palmer (1948). Gunn and Kinzer (1949). Heymsfield and Westbrook (2010). Knight and Heymsfield (1983). | K23 |
| ATMO-05 | Tropical cyclones and large vortices | Hurricanes, tornadoes, dust devils, waterspouts, fire whirls; wind on debris | physics/vortices and the Sky hurricane and tornado | Shared Holland and Rankine/Burgers pressure and wind, live rigid and plant loads without a wind-speed cap, spatial wind and pressure forcing on shallow water (PA-31), optional native wet-cell sampling and accepted signed state with coastal replay | Holland (1980). Willoughby, Darling and Rahn (2006). Fiedler and Rotunno (1986). Orf et al. (2017) for LES. | K13 |
| ATMO-06 | Airborne particle transport | Droplets, spray, dust, ash, embers, snow, seeds, small debris: drag, settling, dispersion | `@margoengine/physics/airborne` and optional Environment density-volume | Native worker transport of natural dust, mist and spray with accepted mass and origin cells. The Environment path renders accepted sea spray. Legacy particle and additional material paths remain open. | Clift, Grace and Weber, *Bubbles, Drops and Particles* (1978). Thomson (1987) for turbulent dispersion. Sardoy et al. (2007) for embers. Costa et al. (2006) for ash. | K06 K18 K23 |
| ATMO-07 | Lightning and atmospheric electricity | Leader branching, return stroke, thunder source | `@margoengine/physics/lightning`, `@margoengine/sky/lightning-bolt` | yes | Niemeyer, Pietronero and Wiesmann, "Fractal dimension of dielectric breakdown" (1984). Rakov and Uman, *Lightning* (2003). Kim and Lin (2004). | K06 K12 |
| ATMO-08 | Fog and cold-air drainage | Radiation fog, valley fog, katabatic flow | physics/drainage-fog; environment/fog-volumes | bulk liquid-water-path closure, signed wind and native parallel phases. The technical valley scene uses the accepted fog grid on both renderers (PA-34) | Manins and Sawford (1979). Duynkerke (1991). Bolton (1980). | K13 K27 |
| ATMO-09 | Surface energy balance | Insolation, ground temperature, evapotranspiration, fuel and ground wetness | `@margoengine/weather/surface-energy`; weather/src/fuel-moisture.ts; weather/src/surface.ts | Implicit heat and liquid/snow budgets on signed-cell patch grids, with optional native helpers. The live rain and wet ground test runs on both renderers. Col de Porte shows a nighttime warm bias. | Monteith (1965). Allen et al., FAO-56 (1998). Liston and Elder, SnowModel (2006). Morin et al., Col de Porte (2012). | K27 |
| ATMO-10 | Synoptic weather and moisture transport | Pressure systems, fronts, geostrophic and gradient wind driving the weather state; water vapour carried across oceans (integrated vapour transport, atmospheric rivers), lifted over mountains and rained or snowed out (orographic precipitation) | `@margoengine/physics/synoptic`, `@margoengine/weather/synoptic` | Regional barotropic and two-layer baroclinic dynamics, balanced pressure, transported fronts and conservative moisture. Orographic wave, rendered weather, land runoff and shallow-water proofs. | Charney, Fjørtoft and von Neumann (1950), barotropic vorticity. Phillips (1954), two-layer growth. Holton, *An Introduction to Dynamic Meteorology* (2004). Dacre et al., "How do atmospheric rivers form?" (BAMS 2015). Smith and Barstad, "A linear theory of orographic precipitation" (J. Atmos. Sci. 2004). | K12 K13 K17 |

### Family EARTH: granular, terrain and solid earth (10)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| EARTH-01 | MPM continuum | Sand, soil, snow, mud, rubble; landslide near-field | `@margoengine/physics/granular-mpm`; `@margoengine/voxel/granular-mpm` | BUILDING: sparse MLS sand and snow on the shared bed, with voxel transfer and ray-driven bed shear. | Stomakhin et al. (2013). Klar et al. (2016). Hu et al., MLS-MPM (2018). Dunatunga and Kamrin (2015). | K12 K15 K24 |
| EARTH-02 | Depth-averaged granular flow | Landslides, rock avalanches, debris flows, lahars, mudflows, dense snow avalanche | physics/granular-flow; weather/src/avalanche.ts; terrain/src/ground-model.ts; scenes/src/fauld-blast.ts | partial. Native shallow finite volumes, Coulomb–Voellmy or measured rough-bed hysteresis, registered terrain, compacted deposition and prescribed pore support. PA-38 legacy bindings and PA-60 erosion stay open. | Savage and Hutter (1989). Pouliquen and Forterre (2002). Iverson and Denlinger (2001). Christen et al., RAMMS (2010). | K14 |
| EARTH-03 | Particle-laden gravity currents | Powder avalanche, pyroclastic flow, blast base surge, dust fronts | weather/src/avalanche.ts (powder); thermal.ts | partial: PA-59 (tuned shapes) | Benjamin (1968). Huppert and Simpson (1980). Dade and Huppert (1996). Esposti Ongaro et al. (2007). | K13 K14 |
| EARTH-04 | Discrete-element rubble and boulders | Rockfall, scree, rubble, grain | physics kernel (partial); voxel/src/debris.ts | partial | Cundall and Strack (1979). | K06 K08 K09 |
| EARTH-05 | Terramechanics | Wheel, track, foot and hoof against soil: pressure-sinkage, shear, ruts, footprints | @margoengine/physics/terramechanics, rigid wheel and belt contacts, LIFE-01 and ATMO-06 | REOPENED for Pass 1: native mean and resolved bearing and shear, plus planar granular resistive forces on moving rigid legs. Live prescribed wheel, belt, foot and hoof loads deform TerrainBed and feed mineral dust. The footprint solver has independent quartz and clay plates, Wh2 drawbar and axle torque, and locked-wheel relief. The Salman plate, Wh32 sinkage and Ishigami directional examples check calibrations. The resistive-force solver has independently measured C-leg lift and thrust in two granular beds. Indexed tread spin, slope-aware bearing, phase-driven digging and reciprocal wheel reactions are available. Native granular strips support joined 1/2/4 participants. The fixed camera soil-bin case uses restored rigid wheel poses and accepted grain mass on both renderers. Further measured dynamic camber forces, transient stress traces and shared changing layers are tracked in [known bugs](known-bugs.md) and the [framework requests](physics-work-queue.md#framework-requests). | Bekker (1969). Wong, Theory of Ground Vehicles. Janosi and Hanamoto (1961). Sumner, O'Brien and Hodgins (1999). Ding et al. (2009, 2010, 2011). Apfelbeck et al. (2011). Salman et al. (2020). Ishigami et al. (2007). Pavlov (2023). Li, Zhang and Goldman (2013). | K07 K09 K15 |
| EARTH-06 | Impact and explosion cratering | Crater size from energy and burial, ejecta curtain, mass balance | physics/src/crater (`CraterSolver` reading FIRE-05's explosions, writing the terrain bed; the older terrain and scene stand-ins remain) | framework solver (2026-11-27): crater size by point-source scaling with the burial fitted to Nevada's alluvium shots, the bowl and rim formed over the formation time, an ejecta curtain of ballistic shells landing as a blanket, the bed's volume balanced to rounding. A hydrocode tier is not built | Holsapple and Housen, crater-scaling theory notes (2015). Housen and Holsapple, "Ejecta from impact craters" (2011). Nordyke (1961). Nordyke and Williamson, the Sedan event (1965). Toman (1970). McGetchin, Settle and Head (1973). | K07 K23 |
| EARTH-07 | Aeolian transport | Saltation, dust emission, impact ripples, dunes | physics/aeolian; vfx/blown-sand | PA-46, PA-63. Coded transport rejection, native participant counts and a live two-renderer snow ridge. Independent sand flux misses four of six runs. | Sauermann, Kroy and Herrmann (2001). Werner (1995). Kok et al., "The physics of wind-blown sand and dust" (2012). Pomeroy and Gray (1990), snow saltation. Anderson (1987), impact ripples. Creyssels et al. (2009), measured tunnel flux. | K14 |
| EARTH-08 | Seismic waves and ground shaking | Source, propagation, site amplification, liquefaction, building response | physics/seismic | Staggered SIMD elastic section, layered sites, free-surface acceleration, cyclic-stress screening, Newmark buildings and rigid support loads. Native workers join between deterministic velocity and stress rows. Accepted fields replay the civil station on both renderers. | Virieux (1986). Komatitsch and Tromp (1999). Seed and Idriss (1971). Newmark (1959). | K12 K19 |
| EARTH-09 | Volcanic eruption column | Plinian column, collapse, umbrella cloud, ballistics | weather/src/eruption.ts, thermal.ts | partial: sound deterministic analytic model (Woods, Sparks, Morton-Taylor-Turner) | Woods (1988). Sparks (1986). | K13 K18 |
| EARTH-10 | Lava flow | Conservative vent flux, temperature-dependent Bingham resistance, cooling, crust and levees, solid deposit, natural water displacement | physics/src/lava (LavaSolver), weather/src/lava.ts (analytic channels and visuals) | LANDED: two-dimensional heightfield, live ICE-05 thermal exchange, TerrainBed and SEA-06 source, closed-form and replay checks | Griffiths (2000), Hulme (1974), Costa and Macedonio (2005), Harris and Rowland (2001) | K14 K27 |

### Family ICE: cryosphere (5)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| ICE-01 | Snowpack | Accumulation, wind redistribution, cornices, compaction, melt, slab stability | physics/snowpack; weather/snow and weather/avalanche | layered enthalpy, native column workers, verified heat and meltwater coupling (PA-33) | Bartelt and Lehning, SNOWPACK (2002). Lehning et al., drift in steep terrain (2008). Yu et al., cornice accretion (2023). | K27 |
| ICE-02 | Glacier and ice-sheet flow | Shallow-ice flow, calving, crevasses, icefalls | `@margoengine/physics/glacier` | Grounded flow with conservative implicit face fluxes, Nye depths, marine calving and dry icefalls. Optional native face and fracture workers. Routed melt drives HYDRO-01 and the visual calving release feeds ICE-03 and its wake. | Greve and Blatter, *Dynamics of Ice Sheets and Glaciers* (2009). van der Veen, crevasse fracture mechanics (1998). Benn, Warren and Mottram (2007). | K12 K21 |
| ICE-03 | Iceberg rigid-body dynamics and calving | Capsize, roll, melt, impulse waves | `@margoengine/physics/iceberg` | Six-DOF cuboid capsize, melt and ICE-02 release coupled to a dispersive wake, with optional independent native rows and accepted publication. PA-15 retains grounding and ship contact. | Burton et al., "Laboratory investigations of iceberg capsize dynamics" (2012). Wagner et al. (2017). | K09 K11 K22 |
| ICE-04 | Pack ice and floes | Discrete-element floes, rafting, ridging, ship-ice resistance | `@margoengine/physics/pack-ice`, `@margoengine/water/ice` display | Fixed-mass disks, shared flow, conservative pile volumes, live vessel impulses and optional native drift participants. | Hibler (1979). Hopkins (2004). Herman (2011, 2016). Vella and Wettlaufer (2008). Lindqvist (1989). | K06 K09 |
| ICE-05 | Ice thermodynamics | Freezing and melting of lake, river and sea ice, icicles, frost | physics/src/ice/model.ts and index.ts | Snow-insulated growth, warm surface flux, frost diffusion and water-limited icicles. Optional paired native phase-energy budget and signed lava and runoff fields. | Stefan (1891). Maykut and Untersteiner (1971). Semtner (1976). Makkonen (1988). Murphy and Koop (2005). | K27 |

### Family FIRE: explosions, fire and heat (7)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| FIRE-01 | Wildfire spread | Rothermel rate, wind, slope, fuel moisture, crown fire, fire-atmosphere feedback | vfx/src/fire-front.ts; weather/src/fuel-moisture.ts; biomes/src/fuel.ts, disturbance.ts | partial. Rothermel and Albini are sound in `fire-front.ts`. PA-57 (embers). | Rothermel (1972). Finney, minimum travel time (2002). Linn and Cunningham, FIRETEC (2005). Hädrich et al., "Fire in Paradise" (2021). | K20 |
| FIRE-02 | Flame and fireball | Reacting buoyant flow, flame heat release | vfx/src/fire.ts, flame.ts (particle rendering) | stand-in | Nguyen, Fedkiw and Jensen, "Physically based modeling and animation of fire" (2002). McGrattan et al., FDS (2013). | K12 K13 |
| FIRE-03 | Integral plume and thermal model | Entraining plumes and thermals for explosions, eruptions, fires | weather/src/thermal.ts, eruption.ts | partial: analytic, RK4, deterministic | Morton, Taylor and Turner (1956). Briggs (1969). | K18 |
| FIRE-04 | Explosive blast loading | Overpressure, Friedlander waveform, Mach stem, impulse on bodies and structures | `@margoengine/physics/explosive` (`BlastSolver`, `blastAt`); `post/src/stylize.ts:9` is an artistic warp | built: Kinney and Graham free-air blast with Sachs scaling, Friedlander wave, shock arrival, normal reflection, impulse on rigid bodies and breakables from FIRE-05's explosions field, `pressureAt` for sound and camera shake; no Mach stem yet | Kingery and Bulmash (1984). UFC 3-340-02. Glasstone and Dolan (1977). | K07 |
| FIRE-05 | Explosive source and fragments | Gunpowder and high-explosive release, interior ballistics, recoil, fragment sizes and speeds | `@margoengine/physics/explosive` (`ExplosionSolver`, `fireGun`, `energyBudget`); vfx/src/gunfire.ts, debris.ts and scenes/src/fauld-blast.ts are the old stand-ins | built: energy budget (air as a hemisphere, ground shock by host, crater work, heat), Gurney and Mott fragments, gun interior ballistics and recoil both ways with rigid carriers, Rust/Wasm SIMD flight on 1 to 64 threads landing on the terrain bed, hits into rigid bodies, breakables and hull plates, crater dust into ATMO-06, film direction | Gurney (1943). Mott (1947). Corner, *Theory of the Interior Ballistics of Guns* (1950). | K18 K23 |
| FIRE-06 | Heat conduction and phase change | Hot metal, cooling, ground heating, melt and solidify, thermal stress | physics/src/thermal/ | partial: signed accepted heat and elastic fields, explicit native SIMD participants, exact dual-renderer kiln witness and measured melting limits; original shots and advecting melt open | Carslaw and Jaeger (1959). Voller and Prakash (1987). | K12 K27 |
| FIRE-07 | Burning of structures, ships and solids | Pyrolysis, charring, ignition, strength loss, burn-through | vfx/src/gunfire.ts:1620 (constant spread); fire-front.ts (structures) | stand-in: PA-58 | Drysdale, *An Introduction to Fire Dynamics* (2011). Eurocode EN 1995-1-2 and EN 1993-1-2. | K11 K27 K28 |

### Family SOUND: acoustics (5)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| SOUND-01 | Outdoor propagation | Time of flight, spreading, air absorption, ground effect, wind refraction, terrain diffraction, N-wave | physics/outdoor-sound, audio/outdoor | Weather wind and TerrainBed drive a solved path with eight gains. Audio applies travel time and broad spectral colour. PA-64 has offline PCM evidence at 3 km. | ISO 9613-1, ISO 9613-2. Salomons, *Computational Atmospheric Acoustics* (2001). Gilbert and White (1989). Nord2000 (2001). | K07 K26 |
| SOUND-02 | Enclosed and urban acoustics | Rooms, tunnels, canyons, caves, hull interiors | `@margoengine/physics/room-sound`; mixer/src/reflections.ts and audio/src/zones.ts are convenience paths | Finite specular paths, diffraction, passive wall impedance and optional native pressure partitions. Live cutaway and causal audio pass on both renderers. Ten BRAS rigid-floor excess delays fall within the engineering allowance. | Allen and Berkley (1979). Raghuvanshi and Snyder (2014). Hamilton and Bilbao (2017). Brinkmann et al. (2021), BRAS. | K07 K26 |
| SOUND-03 | Underwater acoustics | Sound-speed profile, ray and beam tracing | physics/src/underwater/index.ts, profile.ts, trace.ts | built: Snell arcs, Gaussian wavefronts, surface and bottom reflections, delay and pressure ports | Jensen et al., *Computational Ocean Acoustics* (2011). Porter and Bucker (1987). | K26 |
| SOUND-04 | Contact and modal sound | Impact, scrape, roll, break, bells, glass, wood, metal | @margoengine/physics/modal-sound | partial: live signed rigid contact and rupture, accepted PCM history, native SIMD track batches and measured plate limits (PA-65) | van den Doel and Pai (1998). van den Doel, Kry and Pai (2001). Zheng and James (2010). | K09 K26 |
| SOUND-05 | Physics-driven fluid, fire, wind and machine sound | Bubbles, splashes, waves, flames, wind noise, engines, rigging creak, cannon | none | none | Moss et al., "Sounding liquids" (2010). Minnaert (1933). Chadwick and James, "Animating fire with sound" (2011). Dobashi, Yamamoto and Nishita (2003). | K26 |

### Family BIO: vegetation and ecosystems (4)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| BIO-01 | Plant mechanics under wind and water | Trees, shrubs, grass, crops, reeds, kelp: modal response, breakage, windthrow, felled trees; kelp, sea grass and soft corals sway in the water velocity below the surface | `@margoengine/physics/vegetation` and `@margoengine/scatter/plant-motion` | modal wind and water response, native worker integration, rigid impacts and real sea-surge posing through Scatter (PA-30) | de Langre, "Effects of wind on plants" (2008). Stam, "Stochastic dynamics" (1997). Habel, Kusternig and Wimmer, "Physically guided animation of trees" (2009). Gardiner et al., ForestGALES (2000). | K17 K18 K22 |
| BIO-02 | Plant growth and morphogenesis | L-system growth, tropisms, competition | `@margoengine/biomes/growth` and live branch graphs for `procedural/lsystem` | partial: accepted signed branch and HYDRO-02 soil replay, voxel shadow SIMD participants and independent shade limits | Prusinkiewicz and Lindenmayer (1990). Palubicki et al. (2009). Pirk et al. (2012). | K06 |
| BIO-03 | Forest ecosystem dynamics | Competition, seeding, mortality, succession, chronic wind-shaped growth and tree–soil feedback | `@margoengine/biomes/forest`, offline `@margoengine/biomes/ecosystem` | partial: accepted signed forest fields, parallel native crown queries and measured survival limits; reduced competition model | Botkin, Janak and Wallis (1972). Pacala et al. (1996). Cordonnier et al. (2017). | none beyond K01 to K05 |
| BIO-04 | Material ageing | Rust, patina, rot, fouling, stone weathering, wreck decay | `@margoengine/physics/ageing` | partial: staged signed material columns, optional native SIMD, repeated PBR immersion witness and measured outdoor-loss limits | Dorsey and Hanrahan (1996). Gu et al., time-varying surface appearance (2006). | none beyond K01 to K05 |

### Family SPACE: orbital and celestial (3)

| ID | Solver | Phenomenon and model | Packages | State | Best published method | Kernels |
|---|---|---|---|---|---|---|
| SPACE-01 | N-body and orbital dynamics | Kepler and perturbed orbits, SGP4, spacecraft trajectories, re-entry | physics/src/orbit, physics/orbit-kernel, sciviz/src/geo-sgp4.ts, shader/src/black-hole.ts | built: symmetric gravity, rotational figure, atmospheric drag, analytic Kepler states and a drifting disk emitter on the replay clock | Hairer, Lubich and Wanner (2006). Wisdom and Holman (1991). Yoshida (1990). Rein and Spiegel (2015). Vallado et al. (2006). | K06 K18 |
| SPACE-02 | Celestial ephemeris and rotation | Sun, moon, planets, eclipses, tidal drive | physics/src/space/solver.ts, spk.ts, tracker.ts | built: dyadic analytic and SPK ephemeris, optional SIMD Standish orbit rows, signed insolation and tide ports, slope-aware tracking | Meeus, *Astronomical Algorithms* (1998). Standish, JPL fitted planet elements. Wallace and Capitaine (2006). | K18 |
| SPACE-03 | Accretion disks and motion near compact objects | Keplerian shear, viscous mass transport and heating, and Schwarzschild/Kerr trajectories | `@margoengine/physics/accretion` | Built: conservative thin disk, accepted native SIMD annulus fields and exterior timelike and null tracers. Original Event Horizon field binding is open. | Shakura and Sunyaev (1973). Pringle (1981). Chandrasekhar (1983). Balbus and Hawley (1991). Fujita and Hikida (2009). | K13 K18 |

## 2. Families and shared kernels

### 2a. Family overview

| Family | Scope | Solvers |
|---|---|---|
| DYN | Rigid, articulated and contact dynamics | 8 |
| SOFT | Deformables | 6 |
| BREAK | Fracture, structures and impact | 5 |
| LIFE | Characters, animals, crowds and machines | 7 |
| AERO | Aerodynamics and flight | 5 |
| SEA | Ocean, ships and marine | 15 |
| FLUID | General fluid solvers | 7 |
| HYDRO | Rivers, floods and hydrology | 7 |
| ATMO | Atmosphere and weather | 10 |
| EARTH | Granular, terrain and solid earth | 10 |
| ICE | Cryosphere | 5 |
| FIRE | Explosions, fire and heat | 7 |
| SOUND | Acoustics | 5 |
| BIO | Vegetation and ecosystems | 4 |
| SPACE | Orbital and celestial | 3 |
| **Total** | | **104** |

### 2b. Kernel list

**Framework kernels K01 to K05** are used by every solver:

| ID | Kernel |
|---|---|
| K01 | Film clock and fixed-step scheduler (integer tick, never drops time; PA-01, 02, 03, 07) |
| K02 | Deterministic math and counter-based RNG (same bits on every backend, Philox-style) |
| K03 | Constants, units, ISA atmosphere and one material database (gravity PA-08, density, friction, strength, viscosity) |
| K04 | Field bus: one `sample(x, y, z, t)` interface plus grid and tile storage for wind, water surface, bed height, rain, temperature |
| K05 | Snapshot, restore, bake and keyframe cache (PA-02, 05, 86) |

**Numerical kernels K06 to K29**, with their users from the solver table:

| ID | Kernel | Used by |
|---|---|---|
| K06 | Neighbour search (spatial hash, grid) | DYN-01, DYN-02, DYN-08, SOFT-01, SOFT-02, SOFT-03, LIFE-04, LIFE-05, LIFE-06, SEA-13, FLUID-01, FLUID-02, ATMO-06, ATMO-07, EARTH-04, ICE-04, BIO-02, SPACE-01 (18) |
| K07 | BVH, ray, shape queries, SDF | DYN-01, DYN-04, DYN-05, DYN-06, DYN-07, SOFT-01, BREAK-05, LIFE-06, AERO-01, SEA-12, EARTH-05, EARTH-06, FIRE-04, SOUND-01, SOUND-02 (15) |
| K08 | Convex shape distance and CCD | DYN-01, DYN-02, DYN-08, EARTH-04 (4) |
| K09 | Contact and constraint solve (sequential impulse, XPBD, VBD, graph colouring) | 32 solvers: DYN-01 to 05 and 07 to 08; SOFT-01 to 06; BREAK-01 to 03 and 05; LIFE-01 to 03 and 05 to 07; AERO-02, 05; FLUID-01, 02; EARTH-04, 05; ICE-03, 04; SOUND-04 |
| K10 | Articulated-body algorithms | DYN-03, DYN-07, SOFT-05, LIFE-01, LIFE-02, LIFE-03, LIFE-07, AERO-03, SEA-08 (9) |
| K11 | Mesh geometry: volume, inertia, clipping against a surface, winding number | DYN-06, SOFT-04, SOFT-06, BREAK-01, BREAK-03, AERO-01, SEA-08, SEA-10, SEA-12, ICE-03, FIRE-07 (11) |
| K12 | Sparse linear solve (PCG, multigrid, banded) | SOFT-04, BREAK-02, SEA-04 to SEA-07, FLUID-03, FLUID-04, FLUID-06, FLUID-07, HYDRO-02, HYDRO-03, HYDRO-04, HYDRO-06, ATMO-01, ATMO-03, ATMO-07, ATMO-10, EARTH-01, EARTH-08, ICE-02, FIRE-02, FIRE-06 (23) |
| K13 | Eulerian grid: advection, pressure projection, vorticity confinement | FLUID-03, FLUID-04, FLUID-07, ATMO-01, ATMO-03, ATMO-05, ATMO-08, ATMO-10, EARTH-03, EARTH-09, FIRE-02 (11) |
| K14 | Finite-volume Riemann solver (hydrostatic reconstruction, wet and dry) | SEA-05, SEA-06, SEA-07, FLUID-05, HYDRO-01, HYDRO-02, HYDRO-03, HYDRO-05, ATMO-03, EARTH-02, EARTH-03, EARTH-07, EARTH-10 (13) |
| K15 | Particle-grid transfer and sparse paged grids | BREAK-01, FLUID-03, FLUID-06, EARTH-01, EARTH-05 (5) |
| K16 | SPH kernel summation and iterative density solve | SEA-11, SEA-13, SEA-14, FLUID-01 (4) |
| K17 | FFT and spectral synthesis | SEA-01, SEA-02, SEA-03, ATMO-01, ATMO-02, ATMO-10, BIO-01 (7) |
| K18 | ODE integrators (RK4, adaptive, symplectic, closed-form spring) | DYN-04, DYN-05, SOFT-03, BREAK-04, LIFE-01, LIFE-04, LIFE-07, AERO-03, AERO-04, AERO-05, SEA-08, SEA-09, ATMO-06, EARTH-09, FIRE-03, FIRE-05, BIO-01, SPACE-01, SPACE-02 (19) |
| K19 | FEM and Projective Dynamics | SOFT-04, SOFT-05, BREAK-02, BREAK-03, EARTH-08 (5) |
| K20 | Eikonal and level-set front solver | SEA-06, FIRE-01 (2) |
| K21 | Drainage-graph routing | HYDRO-02 to HYDRO-05, ICE-02 (5) |
| K22 | Surface-integral load integrator (per-triangle pressure, drag, lift, wetted and projected area) | LIFE-03, AERO-01 to AERO-05, SEA-08 to SEA-12, SEA-14, ICE-03, BIO-01 (14) |
| K23 | Batched particle ballistics with drag and scene collision | BREAK-04, BREAK-05, ATMO-04, ATMO-06, EARTH-06, FIRE-05 (6) |
| K24 | Small dense linear algebra (3×3 SVD, polar, QR) | DYN-06, SOFT-02, SOFT-04, SOFT-05, FLUID-06, EARTH-01 (6) |
| K25 | Wave dispersion and wave-action transport | SEA-01 to SEA-05, SEA-14 (6) |
| K26 | Acoustic kernels (delay lines, FDTD, ray and beam tracing, modal banks) | SOUND-01 to SOUND-05 (5) |
| K27 | Heat stencil and phase change | ATMO-08, ATMO-09, EARTH-10, ICE-01, ICE-05, FIRE-06, FIRE-07 (7) |
| K28 | Graph connectivity (union-find, max-flow, load path, compartments) | BREAK-01, BREAK-02, SEA-10, FIRE-07 (4) |
| K29 | Optimisation and control (QP, LQR, time-optimal parametrisation) | DYN-03, DYN-07, LIFE-01, LIFE-02, LIFE-03 (5) |

**Where these already exist in the repo.**
- K07, K08, K09 and K10 are in the physics Rust kernel and in `bvh`.
- K17 is in `compute` and `water/src/fft.ts`.
- K21 is partly in `biomes/src/hydrology.ts` and `erosion.wasm`.
- K13 and K14 are partly in `sciviz/src/flow.wasm` and `water/src/flood-shaders.ts`.
- K26 is partly in the `mixer` and `audio` packages.
- K01 to K05 do not exist as one framework yet. The audit names five separate clocks, about 25 copies of 9.81 and a second wind field.

## 3. Coupling matrix

In the "Direction" column, "one-way" is written A→B. Everything not listed is not required.

### Atmosphere and wind

| Pair | Coupling quantity | Direction |
|---|---|---|
| ATMO-01/02 → AERO-01 | Local air velocity, density | one-way |
| ATMO-01/02 → AERO-02 (sails, flags) | Relative wind; thrust and heeling force go back to the hull via SEA-08 | two-way (sail to hull) |
| ATMO-01/02 → BIO-01 (trees, grass) | Wind drag per canopy element | one-way. Added canopy drag feeds back to the boundary-layer roughness in ATMO-01 (two-way at roughness level). |
| ATMO-01/02 → SOFT-01/03 (cloth, hair) | Wind drag on triangles and strands | one-way |
| ATMO-01 → SEA-01 | Wind stress, fetch, duration | one-way. Wave-induced roughness feeds back to the wind profile (weak two-way). |
| ATMO-01 → ATMO-06 (spray, dust, ash, embers) | Air velocity and turbulence for particle dispersion | one-way |
| ATMO-01 → FLUID-04, FIRE-03, EARTH-09 (smoke, plumes, eruption column) | Ambient wind bends the plume | one-way. Plume entrainment feeds back to local wind (two-way for large fires: FIRE-01). |
| ATMO-01 ↔ FIRE-01 | Wind and slope set spread; heat release drives fire-induced winds | two-way |
| ATMO-01 → ATMO-03 (clouds) | Advection of cloud density | one-way |
| ATMO-03 → ATMO-04 | Condensate mass produces rain, snow, hail | one-way |
| ATMO-03 → ATMO-01 | Convective downdrafts, outflow gusts | one-way |
| ATMO-05 (vortices) → BIO-01, BREAK-02, ATMO-06, SEA-07 | Wind field, pressure drop; debris loading; surge forcing | one-way |
| ATMO-07 → SOUND-01 | Timed thunder segments feed outdoor source positions and emission times | one-way; checked in `packages/physics/tests/coupling/lightning.test.js` |
| ATMO-09 → FIRE-01, ICE-01, HYDRO-02 | Fuel moisture, melt energy, evaporation | one-way |

### Water, ships and sea

| Pair | Coupling quantity | Direction |
|---|---|---|
| SEA-02 → SEA-08 | `seaSurface` height, normal, orbital velocity at hull triangles | one-way. Hull displacement writes back through SEA-04 (two-way). |
| SEA-08 ↔ SEA-04 | Hull displaced volume and pressure drive wake; wave-making resistance returns | two-way |
| SEA-01 ↔ SEA-04/SEA-05 | Swell enters the nearshore domain; reflection and breaking dissipation return | two-way at the boundary |
| SEA-01 → SEA-02 | Spectrum sets amplitudes | one-way |
| SEA-05 ↔ HYDRO-01 | Wave radiation stress drives currents; currents refract waves and carry sediment | two-way |
| SEA-05, SEA-07 → HYDRO-01 | Water level at the river mouth (backwater, surge) | one-way. River discharge feeds the sea outflow plume. |
| SEA-08 ↔ SEA-09 | Thrust, rudder and resistance forces; motion changes inflow | two-way |
| SEA-08 ↔ SEA-10 | Flooded mass shifts weight and stability; heel changes flooding | two-way |
| SEA-10 → SEA-15 | Cargo carried out of a breached hold by the flooding flow (iron ore, coal, grain, oil) becomes a tracer source at the breach | one-way |
| LIFE-03 → SEA-15 | Downward swimming impulses spread over the bed and entrain sand or silt above its Shields threshold. Tracers carry, diffuse, and settle the resulting plume. | one-way |
| SEA-10 → SEA-13 | Air escaping a flooding or sinking hull becomes a bubble plume and boil at the surface | one-way |
| BREAK-04/05, FIRE-05 → SEA-10, SEA-08 | Hit location, impulse, hole area | one-way into SEA-10 |
| FIRE-07 → SEA-10 | Burnt-through hull, mass loss | one-way |
| SEA-08 ↔ BREAK-03 | Contact energy deforms the hull; added flooding and recoil | two-way |
| SEA-08 ↔ ICE-04 | Ice resistance on the hull; ship breaks or pushes floes | two-way |
| SEA-08 ↔ DYN-01 (cargo, crew, cannon) | The deck as a moving platform; recoil and shifting loads act back | two-way |
| SEA-08 ↔ SOFT-02 (rigging, anchor chain) | Tension on the hull; hull motion on the line | two-way |
| SEA-08 ↔ SEA-14 | EntrySolver reads the carried hull through the rigid-body field for cavity, splash and foam. Its optional cavity-pressure field clips the hull's wetted load behind the open contact plane. HullSolver supplies the hull load and wake displacement. | two-way |
| SEA-04, SEA-14 → SEA-13 | Breaking and splash set foam and spray source | one-way |
| SEA-13 → ATMO-06 | Spray droplets enter the air | one-way. Spray evaporation cools air and adds moisture (weak return). |
| SEA-12 ↔ HYDRO-01 | Flood velocity and depth load bodies (drag, buoyancy); bodies block flow | two-way |
| SEA-12 ↔ DYN-01 | Hydrodynamic forces on rigid bodies; body motion changes the load | two-way |
| LIFE-01/03 ↔ SEA-12 | Animals wading, swimming, carried by flow; swimmers displace water | two-way |
| SEA-06 ← EARTH-02, ICE-03, ICE-02 | Slide, calving or fault volume source | one-way. EARTH-02 publishes conserved moving and consolidated submergence through SeaSource. |
| SEA-07 ← ATMO-05, ATMO-10, SPACE-02 | Wind stress, pressure, tidal potential | one-way |
| FLUID-01/03 ↔ SEA-04/HYDRO-01 | Particle liquid hand-off to and from the surface solvers (mass and momentum exchange) | two-way; FLUID-01 has a real wet-cell HYDRO-01 test, with shoreline and SEA-04 receipts still open |
| FLUID-01/02 ↔ DYN-01 | Boundary particles and pressure forces on rigid bodies | two-way; FLUID-02 has a staggered live rigid pose and impulse test in `packages/physics/tests/coupling/pbf.test.js` |

### Rivers, rain, terrain and sediment

| Pair | Coupling quantity | Direction |
|---|---|---|
| ATMO-04 → HYDRO-02 | Rain rate (mm/h) and drop energy | one-way |
| ATMO-04 → SEA-04 | Rain impacts as ring sources; rain damps short waves (Tsimplis 1992) | one-way |
| ATMO-09 → HYDRO-02 | Evaporation, snow melt | one-way |
| HYDRO-02 → HYDRO-01 | Runoff discharge into channels (PA-24) | one-way |
| HYDRO-01 ↔ HYDRO-03 | Flow velocity and depth set sediment transport; the bed update changes flow | two-way |
| HYDRO-03 → HYDRO-04 | Rates and shear thresholds set long-term incision | one-way. The landscape evolves under a time-averaged flow. |
| HYDRO-04 ↔ terrain bed height (K04) | The shared bed written by erosion, slides and craters; read by colliders (PA-37) | two-way |
| HYDRO-05 ↔ HYDRO-01 | Breach hydrograph, then bed and wall erosion as flow overtops | two-way |
| HYDRO-06 → HYDRO-01 | Baseflow and springs | one-way. Infiltration from HYDRO-02 goes back to groundwater. |
| ICE-01, ICE-02 → HYDRO-01/02 | Meltwater discharge | one-way |
| HYDRO-01 ↔ EARTH-02 | Debris flow entrains water; sediment-laden flow changes viscosity | two-way |
| HYDRO-03 ↔ BIO-03 | Flood disturbance resets vegetation; roots stabilise banks (PA-47) | two-way |

### Fire, blast and debris

| Pair | Coupling quantity | Direction |
|---|---|---|
| FIRE-04 → DYN-01, BREAK-01, BREAK-02, BIO-01, SOFT-01 | Overpressure and impulse on bodies, structures, trees, cloth | one-way |
| FIRE-04 → SOUND-01, cameras (PA-66) | Pressure arrival drives sound and camera shake | one-way |
| FIRE-05 → BREAK-01, EARTH-06, ATMO-06, FIRE-03 | Ejecta mass and speed from the charge; hot gas source | one-way |
| FIRE-05 ↔ DYN-01/SEA-08 (cannon, ship) | Recoil impulse on the carrier | two-way |
| EARTH-06 ↔ HYDRO-04 bed | Crater removes and deposits mass on the shared bed | two-way |
| FIRE-03/FLUID-04 ↔ FIRE-01 | Plume lofts embers; heat release drives the plume | two-way |
| FIRE-01 → ATMO-06 | Ember flight and spotting | one-way. A spot fire starts at the landing (back into FIRE-01). |
| FIRE-01 ↔ BIO-03, ATMO-09 | Fuel load, moisture; burn scar changes fuel | two-way |
| FIRE-07 ↔ BREAK-02 | Heat reduces strength; collapse changes air supply and spread | two-way |
| FIRE-07 → SEA-10 | See above | one-way |
| EARTH-09 → ATMO-06 | Ash and tephra particles; fallout builds a bed layer | one-way |
| EARTH-09 ↔ ATMO-01 | Column entrains wind; wind bends the plume | two-way |
| EARTH-10 (lava) ↔ ICE-05, ICE-01, SEA-14, EARTH-02 | ICE-05 heat, meltwater and steam. Lava displacement enters SEA-06 on the layout shared with SEA-14. TerrainBed supplies heights and LavaSolver publishes solid deposits. | Staggered ICE-05 heat and phase exchange, plus one-way signed displacement into water. Direct distributed ICE-01 and EARTH-02 bindings still need the shared contracts. |
| EARTH-03 ↔ EARTH-02 | Dense core produces the powder cloud; the cloud's deposit changes the bed | two-way |
| EARTH-02/03 → BIO-01, BREAK-02 | Dynamic pressure fells trees and walls; obstacles take momentum from the flow (PA-33) | two-way |
| EARTH-08 → BREAK-02, EARTH-02, DYN-01, cameras | Ground acceleration shakes bodies, triggers slides and liquefaction | one-way. EARTH-02 consumes the live horizontal and vertical SeismicGround records for inertial drive and Coulomb unloading. |
| BREAK-01 ↔ DYN-01/DYN-08 | Fracture creates bodies; contact impulses cause damage | two-way |
| DYN-01 ↔ EARTH-04, EARTH-05 | Rubble contact, soil reaction on vehicles, feet and hooves | two-way |
| EARTH-05 ↔ terrain bed | Redistributed volume and changed height-field and foot contacts | two-way, `packages/physics/tests/coupling/terramechanics.test.js` |
| LIFE-01 → EARTH-05 → ATMO-06 | Hoof and shoe forces produce permanent indentation and airborne mineral particles | checked with actual quadruped and biped contact fields |
| EARTH-07 ↔ ATMO-01 | Wind stress lifts sand; saltation layer slows wind | two-way |
| EARTH-07 → ATMO-06 | Dust emission | one-way |

### Characters, animals, crowds and machines

| Pair | Coupling quantity | Direction |
|---|---|---|
| LIFE-01/LIFE-06 ↔ DYN-07 | Ragdoll hand-off on hit, knock-down; control back to animation on recovery | two-way |
| LIFE-06 (rider) ↔ LIFE-01 (horse) | Rider mass, lean, seat spring-damper | two-way (PA-72) |
| LIFE-01/05/06 ↔ DYN-01, DYN-04 | Hoof, foot and wheel forces on the ground and on moving decks | two-way |
| LIFE-05 ↔ LIFE-06 | Individuals in a formation: contact forces | two-way |
| LIFE-05 → DYN-07, BREAK-05 | Crush force; hits from projectiles | one-way |
| BREAK-04/05 → DYN-07, LIFE-01 | Projectile impulse on a character or horse | one-way |
| LIFE-07 ↔ DYN-03 | Actuator force and load | two-way |
| LIFE-07 ↔ AERO-04, SEA-12 | Windmill, waterwheel, oars: shaft torque vs flow | two-way |
| AERO-04 → ATMO-01 | Wake and momentum deficit behind turbines | one-way (weak two-way for farms) |
| AERO-03 ↔ ATMO-01/02 | Gust response; wake vortex into the air | two-way for large craft. One-way for birds. |
| SOFT-01/02/03 ↔ DYN-01 | Cloth, rope and hair against bodies; reaction forces | two-way |
| SOFT-03 → ATMO-01 | None (the mane sees wind only) | one-way (ATMO → SOFT) |
| SOFT-05 ↔ DYN-07 | Soft tissue on a moving skeleton | one-way (skeleton drives tissue) |

### Sound

| Pair | Coupling quantity | Direction |
|---|---|---|
| DYN-01, BREAK-01, SEA-14, FLUID-01, FIRE-02, ATMO-07 → SOUND-04/05 | Contact impulses, fluid events, flame state, thunder | one-way |
| ATMO-01, ATMO-09 → SOUND-01 | Wind and temperature gradients refract sound | one-way |
| SOUND-01/02 → SEA-08 / BREAK-02 | Vibration loading (low priority, ignored) | none |
| EARTH-02 (surface geometry, K07) → SOUND-02 | Tunnels and canyons as acoustic geometry | one-way |

### Ecology and astronomy

| Pair | Coupling quantity | Direction |
|---|---|---|
| SPACE-02 → SEA-07, ATMO-09 | Tidal potential, insolation | one-way |
| BIO-01 ↔ DYN-01 | Felled trees as rigid bodies; impact felling | two-way |
| BIO-03 ↔ HYDRO-04, ICE-01 | Roots and cover stabilise slopes; erosion removes soil | two-way |

## 4. State, order and owners

**State across the 104.**
- Sound: DYN-01, DYN-02, DYN-04 (road vehicles), HYDRO-01 (the flood core) and the SGP4 part of SPACE-01.
- Partial: about 25. The deterministic analytic models in weather, vfx and sky count here: avalanche, eruption,
  lava, thermal, fire front, hurricane and tornado, snow drift and fuel moisture.
- Stand-in: about 40. These are the kinematic or scripted pieces the audit lists.
- None: about 30.

**Shared kernels.** 29 kernels (K01 to K29). K09 serves 32 solvers, K12 serves 23, K18 serves 19 and K06 serves 18.
Each kernel is written once and shared; a second copy of a kernel is a defect.

**Build order** (from [physics-framework.md](physics-framework.md)):
1. Foundation: the film clock and dyadic solver rates, the shared-memory module layout, the world, field registry
   and scheduler, the solver interface (snapshot, restore, hash), kernels K01 to K05 and the most shared kernels,
   the coupling-test harness, and worker threads. The rigid and soft kernels move onto the solver interface.
2. Vertical slice, a ship at sea: SEA ocean surface and hull solvers, ATMO wind, DYN-01 rigid contact, and their
   couplings, proven end to end on a real shot.
3. Fan-out: every remaining solver in dependency order (a solver starts once the solvers and kernels it reads are
   sound).

**Owners by family.**
- Rigid, granular, terrain and destruction (DYN, EARTH, BREAK), plus the time foundation and threads.
- Ships, floating bodies, characters, animals and crowds (SEA hull side, LIFE, SOFT-03, SOFT-05), plus gravity.
- Atmosphere, vegetation and cloth (ATMO, AERO, FIRE, BIO, SOFT-01, SOFT-02, SOFT-04, SOFT-06, SOUND).
- Ocean, waves, hydrology and particle fluids (SEA surface side, FLUID, HYDRO, ICE, SPACE), plus the film clock.

**Scope decisions.**
- Rider and mount coupling is a coupling pair, not a separate solver.
- Water entry (SEA-14) is its own solver.
- The sailing hull sits inside SEA-09, together with the sail model AERO-02.
- Lower-priority entries: BIO-04, SOUND-03, DYN-05, ICE-05, HYDRO-06 and SEA-03. Lower priority orders the work; it
  does not remove a solver.
- Rendering-only phenomena (aurora, rainbows, caustics, heat-haze optics) are not solvers. They read the temperature
  and particle fields the solvers above publish.
