# Physics parity bar: what every solver must have

Scott, 2026-11-26: "go through all 100 and make every one on parity with Babylon and three js, not exceeds but must
meet", and name "the 10-15 that absolutely have to be perfect for max adoption". "I want the Md to contain everything
each one must have."

This replaces the 2026-11-26 "best most powerful" standard in `docs/physics-work-queue.md` for every solver except the
14 in Part 2. Catalog: `docs/physics-solvers.md` (109 rows). Status today: `docs/physics-work-queue.md`.

## How the bar was set

- **Babylon.js** means Physics V2 (Havok) plus the built-in particle, water, audio and navigation features. Legacy V1
  (Ammo) soft bodies are counted, because Babylon still documents them.
- **three.js** means its add-on helpers (AmmoPhysics, JoltPhysics, RapierPhysics) and its official examples
  (`physics_*`, `webgl_gpgpu_*`, `webgpu_compute_*`). Where an example uses Rapier, the bar is what that example shows,
  backed by Rapier's published feature list (already tracked row by row in `docs/physics-collision-parity.md`).
- Sources: official docs, example pages and `threejs.org/examples/files.json` only, read 2026-11-26. No engine source
  was read (clean room).
- **Must meet, not exceed.** Where neither rival has the feature, the bar is only the baseline below. Work beyond the
  bar is not required and should stop unless Scott asks for it or a film needs it (a film need is decided per film, not here).

## Part 1: the baseline every solver must have (all 109)

1. A public API in its optional entry: ESM, full types, no globals, no side effects on import, lazy-loaded; core and
   stage gain zero bytes.
2. A README example that runs as written (`check:readme-run`), every option documented with its default.
3. Coded errors (`MargoError` with a help link) for bad input, naming the fix. No plain `TypeError`/`RangeError`.
4. Stable across its documented range: no NaN, no blow-up, no energy gain in normal use; out-of-range input refused.
5. Deterministic: the same inputs give the same state hash, including after a snapshot and restore.
6. Tests: at least one closed-form or measured check of its main behaviour, plus the determinism test. No loosened
   bounds.
7. Honest docs: `docs/limits.md` says what it does not do; open defects in `docs/known-bugs.md`.
8. Passes the gate before it lands: `npm run quality` green for its own entries (tsdoc on every export, an importing
   test for every entry, size rows recorded, README types). Physics landings stop turning `main` red for other lanes.
9. Works on both WebGPU and the WebGL2 compatibility layer where it draws or uses the GPU.

A solver whose rivals have nothing is **finished when the baseline holds**. Its REOPENED audit list is no longer
required.

## Part 2: the 14 that must be perfect (max adoption)

These are what three.js and Babylon users reach for first. "Perfect" means: every item below, the union of both rivals
(and Rapier where three.js uses it), the baseline, plus:

- a copy-paste quick start that runs in under 10 lines;
- a three.js migration note (how the same thing is written with the Rapier/Ammo example vs Margo);
- an example page;
- a debug view;
- speed at least equal to the rival's own demo of the same scene. Measured in the quiet speed phase, per AGENTS.md; no
  timing gates before then.

### P1. DYN-01 3D rigid bodies and contact

- **Body types:** dynamic, static (fixed), kinematic by position and by velocity (Babylon "animated"); switch type at
  runtime.
- **Body properties:** mass and inertia overrides, centre of mass, linear and angular damping, gravity scale, per-body
  CCD, sleeping with wake on touch, lock axes (translation and rotation).
- **Motion:** forces, impulses and torques at a point, set velocity, `SetTargetTransform`-style kinematic targets.
- **Field forces (Babylon helpers):** radial explosion, gravitational field, updraft, vortex.
- **Contacts:** friction and restitution with combine rules, contact events (started, continued, ended), contact
  forces, trigger/sensor volumes with enter and exit, collision groups and filters, one-way and hook filtering.
- **Queries:** raycast (first hit, all hits), shape cast, point projection, overlap/intersection tests, filtered by
  group.
- **Instancing:** thousands of instanced bodies behind one draw call, with instance-index APIs (Babylon thin
  instances; three.js `physics_*_instancing`).
- **Terrain:** heightfield bodies (three.js `physics_rapier_terrain`, `physics_ammo_terrain`).
- **Rapier parity:** every row of `docs/physics-collision-parity.md` DONE. Today 234 DONE, 10 PARTIAL, 4 MISSING of
  254.

### P2. DYN-06 Mass properties and collision geometry

- **Shapes:** sphere, box, capsule, cylinder, cone, convex hull, triangle mesh, heightfield, compound/container,
  rounded variants.
- **Mass and fitting:** mass and inertia computed from density for every shape; convex decomposition of a concave mesh
  (Rapier has it); trimesh from any glTF mesh with no extra work; scaled shapes.
- **Robustness:** open and non-manifold meshes refused or repaired with a coded error, never NaN. Today PA-87, PA-88 and
  PA-09 are open.

### P3. DYN-03 Joints and motors

- **Joint types:** fixed (lock), ball-and-socket, hinge (revolute), prismatic (slider), distance, rope, spring, generic
  6-DoF.
- **Limits:** per-axis on every joint (not just 6-DoF; Babylon's weak spot).
- **Motors:** velocity and position on each free axis, with max force; break force; enable or disable collision
  between connected bodies.
- **Reduced-coordinate chains:** multibody chains (Rapier has them) for robot arms and ragdolls.

### P4. DYN-07 Character controller and ragdoll

- **Controller:** a kinematic capsule controller with slopes (max climb angle, slide), autostep over small ledges, snap
  to ground, moving platforms, pushing dynamic bodies, ground and support detection, jump (Rapier
  KinematicCharacterController plus Babylon PhysicsCharacterController).
- **Ragdoll:** built from a skeleton with per-bone shapes and rotation limits; starts kinematic, switches to dynamic on
  hit or death and back; sizes computed automatically from the skin (Babylon does not do this, but setup must not be
  manual).
- **Today:** PA-67, PA-77 and PA-78 are open, and "characters never enter the world".
- **2026-11-27 (Claude, laptop):** controller complete against the list: slopes, slide, autostep, snap, platforms, pushing,
  ground and support readings (`grounded`, `platform`, `groundNormal`, `slopeAngle`, `platformVelocity`), and `walk`/`jump`
  with gravity (a jump rises v^2 / 2g, `tests/character-walk.test.js`); coded errors and a state for snapshot replay. Ragdoll
  from a skeleton with per-bone shapes, limits, kinematic to limp and back, partial limbs and shapes from the skin
  (`@margoengine/ragdoll`, `/hulls`); the bridge from a controller to a ragdoll and back (`@margoengine/ragdoll/character`).
  Quick start, three.js migration note, example page (`examples/character-controller.html`) and the shared debug view
  (`@margoengine/physics/debug-view`) landed. Still open: PA-67 (humans, horses and armies packages do not use the world),
  PA-77 (foot locking in the animator), PA-78 (the controls walker), and the ragdoll's `fitRagdollShapes` is a call of its
  own rather than automatic.

### P5. DYN-04 Wheeled vehicles

- **Raycast vehicle (three.js `physics_rapier_vehicle_controller`):** per-wheel suspension rest length, stiffness,
  damping and travel; wheel radius; friction slip; steering; engine force; brake; side friction; wheel transforms for
  drawing.
- **Driving:** a working arcade default that drives at once with zero tuning.
- **Today:** the full tyre-model upgrade (MF 6.x) is beyond parity and not required.

### P6. SOFT-01 Cloth

- **Simulation:** GPU cloth (three.js `webgpu_compute_cloth`, verlet in compute) and CPU cloth.
- **Pinning:** anchor vertices to points and to rigid bodies (Ammo cloth).
- **Collision:** with spheres, capsules, boxes and meshes.
- **Forces and drawing:** wind and gravity; stretch and bend stiffness; drawn as a skinned or updated mesh at no extra
  cost.
- **Today:** XPBD cloth is sound. PA-05, 06 and 29 and X-27, 28, 30 and 31 are open. Self-collision and tearing are
  beyond parity.

### P7. SOFT-02 Ropes and chains

- **Rope (Ammo `physics_ammo_rope`):** anchored at either end to a point or a rigid body; collides with rigid bodies;
  length, stiffness and segment count; drawn as a line or tube.
- **Chains:** chains of rigid links through joints.

### P8. SOFT-04 and SOFT-06 Soft volumes (counted as one item)

- **Soft volume (Ammo `physics_ammo_volume`):** a deformable closed mesh that keeps its volume or pressure, collides
  with rigid bodies and the ground, and takes impulses (Babylon V1 soft bodies cannot take forces; Margo must).
- Anchoring and stiffness options.
- **Today:** both are landed and REOPENED. Fracture, FEM tissue and bursting are beyond parity.

### P9. BREAK-01 Breakable objects

- **Convex breaker (three.js `physics_ammo_break`):** a convex object breaks on impact above a threshold into convex
  pieces around the impact point; the pieces become rigid bodies with the right mass; works with any convex glTF mesh.
- Pre-fractured pieces as an option.
- **Today:** `@margoengine/physics/breakable` (landed b63a217ba): convex breaker, pre-fractured or at the hit, pieces as rigid bodies of the exact mass, any convex glTF mesh, quick start, three.js migration note, example page (`examples/physics-breakable.html`) and debug view (`debugRender`). X-40 and X-43 DONE, X-41 and X-42 PARTIAL (concave meshes break as their hull; rigid bonds hold an impulse, not a strain). PA-40, 41 and 44 (voxel collapse and block damage, BREAK-02) and PA-50 (vfx ejecta into rigid bodies) are open in their own packages. Speed against the rival's demo waits for the quiet speed phase.

### P10. SEA-02 Ocean surface

- **Rendering (three.js `webgpu_ocean`, `webgl_shaders_ocean`, the Water add-on, Babylon `WaterMaterial`):** FFT or
  Gerstner waves; wind speed and direction; wave height and length; choppiness; reflection and refraction.
- **Physics:** a height and normal query at any point (on the CPU or one frame behind on the GPU), so things can float.
- **Today:** PA-11 (GPU readback is async only) and PA-16 (`FFTOcean` has no `setWind`) are open, and both are
  parity items.

### P11. SEA-04 Interactive water ripples

- **Ripples (three.js `webgl_gpgpu_water`, `webgpu_compute_water`):** a GPU heightfield; objects and the pointer push
  ripples; ripples spread, reflect and fade; floating objects ride them.
- **Today:** a stand-in (PA-13, 17, 23).

### P12. SEA-12 Buoyancy

- **Floating (three.js `webgl_gpgpu_water` floats spheres):** any rigid body floats on SEA-02 or SEA-04 water with
  buoyancy from its submerged volume, plus drag and angular drag; works on boxes, spheres, capsules, hulls and meshes;
  one call to make a body float.
- **Today:** BUILDING (Codex) and already past parity.

### P13. FLUID-02 and FLUID-03 Real-time particle liquid (counted as one item)

- **Liquid (three.js `webgpu_compute_particles_fluid`, MLS-MPM in compute):** a GPU particle liquid at interactive
  rates, with tens of thousands of particles or more; container walls; pushed by the pointer and by rigid bodies;
  drawn as a fluid surface.
- **Drawing:** the surface pass also draws other particle systems as fluid (Babylon `FluidRenderer`).
- **Today:** FLUID-02 is landed and REOPENED, FLUID-03 is REOPENED, and the GPU path must be proven against the three.js
  demo.

### P14. LIFE-04 Flocking

- **Flocks (three.js `webgl_gpgpu_birds`, `webgpu_compute_birds`):** GPU boids with separation, alignment and cohesion;
  thousands of agents; a predator or pointer avoidance; drives instanced or animated glTF birds or fish.
- **Today:** sound on CPU (`@margoengine/physics/schooling`). The GPU path landed 2026-11-27: `GPUFlock` in `@margoengine/vfx/flocking` flies 16,384 boids on WebGPU (the check; up to 262,144) with the three rules, a vision cone, predators or the pointer, attractors and obstacles, as one instanced draw of built-in or glTF birds or fish, with a quick start, a three.js note, `examples/gpu-flocking.html` and a debug view; on the WebGL2 layer its CPU twin steps it. Open: speed against the rival demo, measured in the speed phase.

Not in the 14, but rivals have them, so they meet parity under Part 3: crowds on a navmesh (Babylon), particles with
forces (both), spatial audio (Babylon), N-body gravity (three.js protoplanet).

## Part 3: every solver, what it must have

**Key to the table:**
- "B" is Babylon; "T" is three.js.
- "Base" means the Part 1 baseline only. Rivals have nothing here, so no further work is required.
- "P#" means the Part 2 list.

**Verdicts:**
- **MEETS:** done once the baseline holds.
- **GAP:** the rival feature named is missing or not proven.
- **PERFECT:** in Part 2.
- **DON'T BUILD:** OPEN, the rivals have nothing, so it is not built unless Scott or a film asks.

### Rigid, articulated and vehicles

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| DYN-01 | 3D rigid body and contact | B Havok; T Rapier/Ammo/Jolt | P1 | CLAIMED, 234/254 Rapier rows | PERFECT |
| DYN-02 | 2D rigid body | none | Base | CLAIMED | MEETS |
| DYN-03 | Articulated bodies, joints, motors | B constraints; T rapier joints | P3 | CLAIMED, partial | PERFECT |
| DYN-04 | Wheeled vehicles | T rapier vehicle | P5 | REOPENED | PERFECT |
| DYN-05 | Rail vehicle dynamics | none | Base | REOPENED | MEETS |
| DYN-06 | Mass properties, collision geometry | B shapes; T helpers | P2 | CLAIMED, partial | PERFECT |
| DYN-07 | Character, balance, ragdoll | B controller and ragdoll; T rapier controller | P4 | OPEN (Codex) | PERFECT |
| DYN-08 | Large-scale GPU rigid dynamics | B thin-instance bodies; T instancing demos | The rival instanced-body counts behind one draw call (covered by P1 instancing). 10^5 to 10^6 bodies is beyond parity | OPEN | MEETS via P1; the 10^6 part is DON'T BUILD |

### Soft bodies

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| SOFT-01 | Cloth and thin shells | T compute cloth, ammo cloth; B V1 cloth | P6 | CLAIMED, partial | PERFECT |
| SOFT-02 | Rods, ropes, cables, chains | T ammo rope; B V1 rope | P7 | REOPENED | PERFECT |
| SOFT-03 | Hair, fur, spring bones | none official (three-vrm is a community add-on) | Base | REOPENED | MEETS |
| SOFT-04 | Volumetric solids (FEM) | T ammo volume; B V1 soft body | P8 | REOPENED | PERFECT |
| SOFT-05 | Muscle, fat, skin tissue | none | Base | OPEN | DON'T BUILD |
| SOFT-06 | Pressure bodies | T ammo volume (pressure) | P8 | REOPENED | PERFECT |

### Breaking and ballistics

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| BREAK-01 | Fracture and destruction | T ammo convex break | P9 | LANDED (physics/breakable, b63a217ba) | PERFECT |
| BREAK-02 | Structural collapse | none | Base | CLAIMED (Fauld film) | MEETS |
| BREAK-03 | Ductile crushing | none | Base | REOPENED | MEETS |
| BREAK-04 | Exterior ballistics | none (projectiles are rigid bodies with CCD under P1) | Base | OPEN | DON'T BUILD |
| BREAK-05 | Terminal ballistics | none | Base | OPEN | DON'T BUILD |

### Living things and machines

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| LIFE-01 | Legged animal locomotion | none | Base | REOPENED | MEETS |
| LIFE-02 | Limbless and small-animal locomotion | none | Base | REOPENED | MEETS |
| LIFE-03 | Aquatic locomotion | none | Base | REOPENED | MEETS |
| LIFE-04 | Flocks, schools, herds | T GPU birds | P14 | GPU path landed 2026-11-27 (vfx/flocking); speed phase open | PERFECT |
| LIFE-05 | Pedestrians and crowds | B navmesh crowd agents | Crowd agents on a navmesh: target, speed, separation, avoidance of obstacles and each other, add and remove agents at runtime | REOPENED | GAP until a crowd-on-navmesh test exists |
| LIFE-06 | Formations, cavalry charge | none | Base | OPEN | DON'T BUILD |
| LIFE-07 | Machines with actuators | none beyond P3 motors | Base | OPEN | DON'T BUILD |

### Air

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| AERO-01 | Aerodynamic loads | none | Base | REOPENED | MEETS |
| AERO-02 | Sails, flags, membranes | none (cloth wind is under P6) | Base | REOPENED | MEETS |
| AERO-03 | Flight dynamics | none | Base | REOPENED | MEETS |
| AERO-04 | Turbomachines | none | Base | OPEN | DON'T BUILD |
| AERO-05 | Falling light bodies | none | Base | REOPENED | MEETS |

### Sea

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| SEA-01 | Wave spectrum | B and T wave controls (wind, height, length) | Wind speed and direction drive the spectrum (with SEA-02) | REOPENED | MEETS when PA-16 closes |
| SEA-02 | Ocean surface and query | T ocean, Water; B WaterMaterial | P10 | REOPENED | PERFECT |
| SEA-03 | Nonlinear and rogue waves | none | Base | REOPENED | MEETS |
| SEA-04 | Local dispersive surface | T GPGPU water | P11 | REOPENED (stand-in) | PERFECT, GAP |
| SEA-05 | Surf zone | none | Base | REOPENED | MEETS |
| SEA-06 | Tsunami | none | Base | REOPENED | MEETS |
| SEA-07 | Tides and surge | none | Base | REOPENED | MEETS |
| SEA-08 | Ship seakeeping | none (floating is P12) | Base | REOPENED | MEETS |
| SEA-09 | Manoeuvring, sailing hull | none | Base | REOPENED | MEETS |
| SEA-10 | Flooding and sinking | none | Base | REOPENED | MEETS |
| SEA-11 | Slamming, green water | none | Base | REOPENED | MEETS |
| SEA-12 | Hydrodynamic loads, buoyancy | T floating spheres | P12 | BUILDING | PERFECT |
| SEA-13 | Whitewater and foam | none (foam is drawing, under water) | Base | REOPENED | MEETS |
| SEA-14 | Water entry and exit | none | Base | REOPENED | MEETS |
| SEA-15 | Tracers and slicks | none | Base | REOPENED | MEETS |

### Fluids

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| FLUID-01 | SPH, accurate | none (B FluidRenderer draws only) | Base | OPEN | DON'T BUILD (P13 covers liquids) |
| FLUID-02 | Position based fluids | T MLS-MPM compute fluid | P13 | REOPENED | PERFECT |
| FLUID-03 | FLIP/APIC liquids | T MLS-MPM compute fluid | P13 | REOPENED | PERFECT |
| FLUID-04 | Smoke and gas | none (both have smoke particles only) | Base; smoke particles are the VFX package | OPEN | DON'T BUILD |
| FLUID-05 | Compressible flow, blast | none | Base | OPEN | DON'T BUILD |
| FLUID-06 | Viscoplastic fluids | none | Base | REOPENED | MEETS |
| FLUID-07 | Thin films, droplets | none | Base | REOPENED | MEETS |

### Rivers, floods and land

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| HYDRO-01 | Shallow water | none | Base | REOPENED | MEETS |
| HYDRO-02 | Rainfall-runoff | none | Base | REOPENED | MEETS |
| HYDRO-03 | Sediment transport | none | Base | REOPENED | MEETS |
| HYDRO-04 | Landscape evolution | none | Base | REOPENED | MEETS |
| HYDRO-05 | Dam and levee breach | none | Base | CLAIMED (Fauld film) | MEETS |
| HYDRO-06 | Groundwater | none | Base | REOPENED | MEETS |

### Weather and air

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| ATMO-01 | Wind field | B wind on WaterMaterial only | A shared wind that cloth, particles, plants and water read | REOPENED | MEETS |
| ATMO-02 | Turbulence and gusts | B particle noise; T none | Noise or gust variation on the shared wind | REOPENED | MEETS |
| ATMO-03 | Clouds and convection | none (sky is drawing) | Base | REOPENED | MEETS |
| ATMO-04 | Precipitation | T compute rain and snow particles | Rain and snow particles that fall, drift with the wind and hit the ground (VFX side) | REOPENED | MEETS when the rain/snow example runs |
| ATMO-05 | Cyclones and vortices | B vortex and updraft force helpers | A vortex and updraft force field acting on bodies and particles | REOPENED | MEETS |
| ATMO-06 | Airborne particles | B GPU particles with gravity, drag, noise, attractors, flow maps; T compute particles, attractors | Particles with gravity, drag, wind, noise, attractors and flow maps; GPU at the rivals' particle counts | REOPENED | GAP until attractors and flow maps are proven on the GPU path |
| ATMO-07 | Lightning | none | Base | REOPENED | MEETS |
| ATMO-08 | Fog drainage | none | Base | REOPENED | MEETS |
| ATMO-09 | Surface energy balance | none | Base | REOPENED | MEETS |
| ATMO-10 | Synoptic weather | none | Base | REOPENED | MEETS |

### Ground

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| EARTH-01 | MPM continuum | T MLS-MPM fluid (liquid only) | Base; liquid MPM is under P13 | OPEN | DON'T BUILD |
| EARTH-02 | Granular flow | none | Base | OPEN | DON'T BUILD |
| EARTH-03 | Gravity currents | none | Base | CLAIMED (Fauld film) | MEETS |
| EARTH-04 | DEM rubble | none (rubble is instanced rigid bodies under P1) | Base | OPEN | DON'T BUILD |
| EARTH-05 | Terramechanics | none | Base | REOPENED | MEETS |
| EARTH-06 | Cratering | none | Base | CLAIMED (Fauld film) | MEETS |
| EARTH-07 | Aeolian transport | none | Base | REOPENED | MEETS |
| EARTH-08 | Seismic | none | Base | REOPENED | MEETS |
| EARTH-09 | Eruption column | none | Base | OPEN | DON'T BUILD |
| EARTH-10 | Lava flow | none | Base | REOPENED | MEETS |

### Ice

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| ICE-01 | Snowpack | none | Base | REOPENED | MEETS |
| ICE-02 | Glaciers | none | Base | REOPENED | MEETS |
| ICE-03 | Icebergs | none | Base | REOPENED | MEETS |
| ICE-04 | Pack ice | none | Base | REOPENED | MEETS |
| ICE-05 | Ice thermodynamics | none | Base | REOPENED | MEETS |

### Fire and explosions

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| FIRE-01 | Wildfire spread | none | Base | OPEN | DON'T BUILD |
| FIRE-02 | Flame and fireball | none (fire is particles in both) | Base | OPEN | DON'T BUILD |
| FIRE-03 | Plumes and thermals | none | Base | CLAIMED (Fauld film) | MEETS |
| FIRE-04 | Blast loading | B radial explosion helper | A radial explosion impulse on bodies in range, with falloff (also under P1 field forces) | CLAIMED (Fauld film) | MEETS |
| FIRE-05 | Explosive source, fragments | none | Base | CLAIMED (Fauld film) | MEETS |
| FIRE-06 | Heat conduction | none | Base | REOPENED | MEETS |
| FIRE-07 | Burning structures | none | Base | OPEN | DON'T BUILD |

### Sound

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| SOUND-01 | Outdoor propagation | B spatial audio | Spatial sources attached to meshes, distance attenuation, panning, listener on the camera | REOPENED | MEETS |
| SOUND-02 | Rooms and urban acoustics | none | Base | REOPENED | MEETS |
| SOUND-03 | Underwater acoustics | none | Base | REOPENED | MEETS |
| SOUND-04 | Contact and modal sound | none | Base | REOPENED | MEETS |
| SOUND-05 | Fluid, fire, wind sound | none | Base | OPEN | DON'T BUILD |

### Plants, materials and space

| ID | Solver | Rivals | Must have | Status today | Verdict |
|---|---|---|---|---|---|
| BIO-01 | Plants in wind and water | none | Base | REOPENED | MEETS |
| BIO-02 | Plant growth | none | Base | REOPENED | MEETS |
| BIO-03 | Forest ecosystems | none | Base | REOPENED | MEETS |
| BIO-04 | Material ageing | none | Base | REOPENED | MEETS |
| SPACE-01 | N-body and orbits | T GPGPU protoplanet gravity | N-body gravity with merging at the rival demo's body count | REOPENED | MEETS when an N-body example matches it |
| SPACE-02 | Ephemeris and rotation | none | Base | REOPENED | MEETS |
| SPACE-03 | Accretion disks | none | Base | REOPENED | MEETS |

## What this means for the work queue

- **Required:** the 14 in Part 2, the four GAP rows in Part 3 (LIFE-05, ATMO-06, SPACE-01's example, ATMO-04's
  example), and the baseline on every landed row, item 8 first so `main` stops going red.
- **Not required:** every other REOPENED upgrade list in `docs/physics-solver-audit.md`; DON'T BUILD rows stay unbuilt.
- **Largest gaps in the 14:** SEA-04 (interactive ripples), DYN-07 (character and ragdoll),
  SEA-02 (`setWind`, sync query), and DYN-01's 14 open Rapier rows.
