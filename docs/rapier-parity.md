# Rapier parity and beyond: physics tracking file

Scott's order, 2026-11-07: Margo's own physics must have every feature and every option Rapier has, one for one, in newer and cleaner code, and do more where it can. A second order the same day: "the most powerful feature rich physics engine possible". This file tracks both. Part 1 is the floor, Rapier parity, and it comes first in the batch order. Part 2 is everything past Rapier.

**Reference.** Rapier 0.36.1 (the `rapier3d` and `rapier2d` crates on docs.rs, Rust user guide 0.36) and `@dimforge/rapier3d` / `@dimforge/rapier2d` 0.21.0 (JS user guide 0.21), inventoried on 2026-11-07. Rapier is Apache-2.0 and is the reference only by name. The inventory was taken clean room: from the public user guide at rapier.rs/docs (Rust and JS, 2D and 3D), the JS API reference pages and the docs.rs type and method pages. No source repository file, no source view page and no example or benchmark code was opened, and nothing beyond names was copied. Part 2 was taken the same way, from public documentation and feature lists only. Rapier's names appear here so a row can be checked against its docs; Margo keeps its own names (the root entry's, in `packages/physics/README.md`) and the row says which one maps to which.

**Where Margo stands.** The root entry `@margoengine/physics` (and `@margoengine/physics2d`) wraps Rapier today. The own solver is a Rust kernel compiled to WebAssembly behind `@margoengine/physics/next`, landed through batch 125 and batch 126 job 1 (commit c1b6acabd, Quickhull). Batch 126 jobs 2 to 5 (shape queries, continuous collision, cylinder and cone) have landed; job 6 (convex decomposition) is being built now on Lane P. Batches 127 to 131 are planned in Scott's batch prompts, which are kept outside the repository; batch 130 is the switch that makes the own solver the root and takes Rapier out. Parity is judged on the own solver: a row is done when the own solver has it with a test, because the wrapper leaves at the switch.

**Backends.** The engine renders on WebGPU and falls back to WebGL2 (`@margoengine/webgl2-compat`, a WebGPU-shaped device on WebGL2, and the smaller `@margoengine/webgl` preview). Every physics feature must work on both. The kernel is CPU WebAssembly, so it runs the same bits whichever backend draws the frame: a row marked `Wasm` in both columns needs no GPU at all. A feature with a GPU path also needs a WebGL2 path (the Wasm kernel, or WebGL2 render-to-texture or transform feedback) that gives the same results within the same tolerances, and its tests run on both. Where WebGL2 cannot reach the same speed, the row says so as an accepted difference with its cause.

**What assumes WebGPU today (checked 2026-11-07, origin/main e0e6494da).** Nothing in `packages/physics/src`, `packages/physics/kernel`, `packages/physics2d/src` or `packages/ragdoll/src` touches `navigator.gpu`, a GPU device or WGSL; the Node tests of all three already run against a mesh renderer stub that says `backend: 'webgl2'`. Two gaps: (1) the physics browser test (`packages/physics/tests/physics-browser.js`) reads pixels back through WebGPU only, so no browser test runs physics on the WebGL2 backends; (2) `debugRender()` buffers are drawn with `@margoengine/lines`, which draws on `webgl2-compat` but on the `@margoengine/webgl` preview backend warns once and draws nothing (its README, Limits). Both are rows below (W-01, W-02).

## Status key

| Status | Meaning |
| --- | --- |
| DONE | The own solver has it, and the named test proves it. |
| PARTIAL | Part is DONE with the named test; the rest is owned by the batch and job named. |
| BUILDING 126 | Lane P is building it now in batch 126. |
| PLANNED N | A planned batch (127 to 131) owns it. |
| MISSING, N.j | Not built and not owned before this file; job j of batch N now owns it. `127.x` and `128.x` are extra jobs added to those batches. |
| N/A | Not a feature a JavaScript engine can have; the row says why and what stands in for it. |

Batch order, parity first (reasons in [Order](#order)): 126, 127, 128, 138, 139, 140, 141, 142, 143, 129, 130, 131, 144, 145, 146, then the beyond batches 147 to 158.

# Part 1: Rapier parity

## Builds and packaging

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| B-01 | `rapier3d` f32 crate, `-compat` JS build with inlined Wasm | Rapier peer, 1.6 MB gzip download | Kernel blueprint inlined in `src/wasm.ts`, no peer | DONE: `kernel-blueprint.test.js` "the blueprint was built from the kernel sources as they stand" | Wasm | Wasm |
| B-02 | `rapier3d-f64`, `rapier2d-f64` (64-bit builds) | no | f32 only | MISSING, 142.2 | Wasm | Wasm |
| B-03 | default 4-lane SIMD with scalar fallback | Rapier's | built with `simd128`; no explicit 4-wide constraint batches, no scalar blueprint for browsers without Wasm SIMD | MISSING, 142.1 | Wasm | Wasm |
| B-04 | `simd8` (8-lane solver) | no | Wasm SIMD is 128-bit, so 8 lanes are two `f32x4`; covered by B-03 | N/A: Wasm has no 256-bit lanes; B-03 gives the same work | Wasm | Wasm |
| B-05 | `parallel` (thread pool, results independent of thread count) | no | none | PLANNED 131 (`/worker`, threads) | Wasm threads | Wasm threads |
| B-06 | `enhanced-determinism` (cross-platform bits) | Rapier's, not tested by Margo | on always, no flag | DONE: `replay.test.js` "10,000 steps of the kernel give the hashes on file", `kernel/tests/replay.rs` `native_code_matches_the_wasm_build_bit_for_bit` | Wasm | Wasm |
| B-07 | `serde-serialize` (world serialization) | not wrapped | one-copy `world.snapshot()` / `restore()` | PARTIAL: DONE for `KernelWorld`: `next-physics.test.js` "a snapshot is the whole world: going back and on again gives the same bits"; `Physics` level PLANNED 128 (3D) and 127 (2D) | Wasm | Wasm |
| B-08 | `block-solver` (two normal constraints of a pair solved together; on in 2D) | Rapier's | none | PARTIAL: PLANNED 127 (2D 2-point); 3D 4-point MISSING, 142.4 | Wasm | Wasm |
| B-09 | `fem` (FEM soft bodies) | no | none | MISSING, 145 | Wasm | Wasm |
| B-10 | `debug-render` | `physics.debugRender()` returns Rapier's buffers | throws `unsupported` | MISSING, 127.x (3D); 2D `/debug` PLANNED 127 | lines | lines on compat; see W-02 |
| B-11 | `profiler` (per-stage counters and timers) | not wrapped | none | MISSING, 138.6 | Wasm | Wasm |
| B-12 | `unsync-callbacks` | n/a | hooks run on the calling thread | N/A: JavaScript callbacks have no `Sync` bound; threads (B-05) never call user code off the main thread | none | none |
| B-13 | debug features (`solver-bounds-checks` and the like) | n/a | NaN and range checks refuse bad input by name | N/A: developer build flags; the coded refusals stand in (`kernel-step.test.js` "settings read back, and values that would put a NaN in the state are refused") | Wasm | Wasm |
| B-14 | `rapier3d-urdf` (URDF robots onto bodies, impulse or multibody joints) | no | none | MISSING, 141.6 (built here) | Wasm | Wasm |
| B-15 | `rapier3d-mjcf` (MuJoCo XML) | no | none | MISSING, 141.6 (built here) | Wasm | Wasm |
| B-16 | `rapier3d-meshloader` (stl, collada, obj into colliders, `MeshConverter`) | `addModel` on loaded glTF and FBX | `addModel` throws until trimesh | PARTIAL: BUILDING 126 (trimesh, `addModel`); converter options MISSING, 139.4 | Wasm | Wasm |
| B-17 | `reserveMemory`, `version` | no | `KernelWorld(capacity)`, `reserve(n)`; no build id | PARTIAL: reserve DONE: `kernel-step.test.js` "addBody grows the world by itself and rows stay where they were"; build id MISSING, 138.6 | Wasm | Wasm |
| B-18 | C, Python and Bevy bindings | n/a | `@margoengine/react/physics` is the framework binding | N/A: other languages; Margo is a TypeScript engine | none | none |

## World, pipelines and integration parameters

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| P-01 | gravity, default (0, -9.81, 0) | `gravity` | `gravity`, `world.setGravity` | DONE: `kernel-step.test.js` "free fall through Wasm follows the closed form with the method term" | Wasm | Wasm |
| P-02 | `step`, `step(eventQueue, hooks)` | `step`, `update` with accumulator | same | DONE: `next-physics.test.js` "defaults: density 1, 8 substeps of 2 passes" | Wasm | Wasm |
| P-03 | `CollisionPipeline`, `detect_collisions` (contacts without dynamics) | no (2D has a zero-length refresh) | none | MISSING, 138.4 | Wasm | Wasm |
| P-04 | manual stepping with caller-owned structures | `world`, `rapier` | typed-array columns over kernel memory | DONE differently: `kernel-step.test.js` "kinds move as their names say" | Wasm | Wasm |
| P-05 | insert and remove bodies, colliders, joints | yes | yes | DONE: `kernel-collider.test.js` "freed rows come back last in, first out, and hold nothing of the old row"; `next-joints.test.js` "a joint reaches the kernel: contactsEnabled, wake, removal" | Wasm | Wasm |
| P-06 | `remove_body_with_colliders(keep)` and standalone colliders (no parent body) | colliders always on a body | same | MISSING, 138.4 | Wasm | Wasm |
| P-07 | iterate bodies, active bodies, colliders, joints | `bodies` list | rows | PARTIAL: active-body list MISSING, 138.5 | Wasm | Wasm |
| P-08 | `wake_up(strong)`, `wake_up_all` | `wakeUp` | `wake` | PARTIAL: DONE per body: `kernel-sleep.test.js` "sleep asks, wake reaches the whole island, setCanSleep holds it up"; `wakeAll` MISSING, 138.3 | Wasm | Wasm |
| P-09 | quarantine (non-finite bodies disabled and reported, world steps on) | Rapier's, not wrapped | stops the world with `MargoError` `failed` | MISSING, 138.4 (both behaviours, chosen by option) | Wasm | Wasm |
| P-10 | generational handles | `valid` on wrappers | rows reused without generation | MISSING, 138.4 (kernel generations, and an own-solver test that a removed body's handle is refused) | Wasm | Wasm |
| P-11 | several worlds | `name` option | each world its own Wasm instance | DONE without a named test; test added in 138.4 | Wasm | Wasm |
| P-12 | `BroadPhaseBvh`, build strategies `Binned` and `Ploc`, optimisation strategy, adaptive margin | Rapier's | sweep and prune with pair cache; trimesh BVH building | PARTIAL: SAP DONE: `kernel/tests/broad.rs` `the_pairs_are_what_brute_force_finds_on_every_step_of_random_scenes`; trimesh BVH DONE (126.2, binned SAH, `kernel/tests/bvh.rs` against brute force); broad phase BVH and strategy choice MISSING, 142.3 | Wasm | Wasm |
| P-13 | `IslandManager` (active bodies, island wake) | Rapier's | union-find islands | DONE: `kernel/tests/sleep.rs` `islands_are_the_connected_groups_of_random_scenes` | Wasm | Wasm |
| P-14 | `dt` | `fixedTimestep` | same | DONE: `next-physics.test.js` "defaults: density 1, 8 substeps of 2 passes" | Wasm | Wasm |
| P-15 | `num_solver_iterations` | `solverIterations` | `substeps` (old name kept) | DONE: `next-physics.test.js` "defaults: density 1, 8 substeps of 2 passes" | Wasm | Wasm |
| P-16 | `num_internal_pgs_iterations` | no | `iterations` | DONE: `kernel/tests/joints.rs` `one_pass_a_substep_still_holds_a_grid` | Wasm | Wasm |
| P-17 | `num_internal_stabilization_iterations` | no | one relax pass, fixed | MISSING, 138.1 | Wasm | Wasm |
| P-18 | `contact_softness`, `static_contact_softness` (Hz and damping ratio) | no | soft step coefficients, internal | PARTIAL: coefficients DONE: `kernel/tests/solver.rs` `the_soft_coefficients_are_the_implicit_spring_of_their_definition`; options MISSING, 138.1 | Wasm | Wasm |
| P-19 | `warmstart_coefficient` | no | warm start always 1 | MISSING, 138.1 | Wasm | Wasm |
| P-20 | `warmstart_joints` | no | joints keep impulses | MISSING (option), 138.1 | Wasm | Wasm |
| P-21 | `length_unit` (scales every tolerance) | no (2D: `pixelsPerMeter`) | metres only | MISSING, 138.1 | Wasm | Wasm |
| P-22 | `normalized_allowed_linear_error` (slop) | no | internal | MISSING, 138.1 | Wasm | Wasm |
| P-23 | `normalized_max_corrective_velocity` | no | internal push-out cap (3 m/s for joints) | MISSING, 138.1 | Wasm | Wasm |
| P-24 | `normalized_prediction_distance` | no | fat-box margin 0.04 m, internal | MISSING, 138.1 | Wasm | Wasm |
| P-25 | `normalized_max_linear_velocity` (per-substep cap) | no | refuses past 1e15 | MISSING, 138.1 | Wasm | Wasm |
| P-26 | `friction_in_bias_pass` | no | fixed | MISSING, 138.1 | Wasm | Wasm |
| P-27 | `friction_model` `Simplified` and `Coulomb` | no | per-point Coulomb with anchored static friction | MISSING (choice), 138.2 | Wasm | Wasm |
| P-28 | `contact_clustering` (3D manifolds with near normals merged) | no | one manifold a pair | MISSING, 138.2 | Wasm | Wasm |
| P-29 | `contact_recycling`, recycle distance | no | warm start by ids, narrow phase every step | MISSING, 138.2 | Wasm | Wasm |
| P-30 | `min_ccd_dt`, `max_ccd_substeps` (0 turns CCD off) | no | none: CCD (126.8) takes one sweep a step | MISSING, 140.5 | Wasm | Wasm |
| P-31 | profiling timers (`timingStep`, broad, narrow, solver, CCD, islands, user changes) | no | none | MISSING, 138.6 | Wasm | Wasm |

## Rigid bodies

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| RB-01 | types `Dynamic`, `Fixed`, `KinematicPositionBased`, `KinematicVelocityBased` | four types | four types | DONE: `kernel/tests/integrate.rs` `a_kinematic_velocity_body_ignores_forces_and_a_fixed_one_never_moves` | Wasm | Wasm |
| RB-02 | `set_body_type` | `setType` | yes | DONE: `next-bodies.test.js` "setType honours wakeUp as the root entry does: asleep until the step, which wakes it and what it touches" | Wasm | Wasm |
| RB-03 | translation, rotation, pose, teleport | yes | yes | DONE: `kernel/tests/pose.rs` `a_pose_is_normalised_and_holds_every_column_that_starts_a_step` | Wasm | Wasm |
| RB-04 | `linvel`, `angvel` | yes | yes | DONE: `kernel/tests/integrate.rs` `the_reported_velocity_is_the_one_that_moved_the_body` | Wasm | Wasm |
| RB-05 | `gravity_scale` | yes | column | DONE without a named test; test added in 138.3 | Wasm | Wasm |
| RB-06 | `linear_damping`, `angular_damping` | yes | yes | DONE: `kernel/tests/integrate.rs` `damping_decays_by_the_implicit_factor_and_towards_the_exponential` | Wasm | Wasm |
| RB-07 | `can_sleep`, `sleeping` at start | yes | yes | DONE: `kernel-sleep.test.js` "sleep asks, wake reaches the whole island, setCanSleep holds it up" | Wasm | Wasm |
| RB-08 | `RigidBodyActivation` per body: linear threshold, angular threshold, time until sleep | no | world-level `setSleep(energy, time)` | PARTIAL: world DONE: `kernel-sleep.test.js` "the thresholds read back and bad ones are refused"; per body MISSING, 138.3 | Wasm | Wasm |
| RB-09 | `ccd_enabled` | `ccd` | `ccd` on `addBody` and `body.ccd` | DONE (126.8): `kernel/tests/ccd.rs`, `tests/next-ccd.test.js` (1,000 bullets at 300 m/s through no wall, mesh or height field; a slow body the same bits with and without) | Wasm | Wasm |
| RB-10 | `soft_ccd_prediction` | no | none: speculative contacts reach as far as the body moves in a step | MISSING, 140.5 | Wasm | Wasm |
| RB-11 | `additional_mass` | `additionalMass` | yes | DONE: `kernel-collider.test.js` "additional mass scales the inertia" | Wasm | Wasm |
| RB-12 | `additional_mass_properties` (mass, centre, principal inertia, frame) | `setMassProperties` | yes | DONE: `next-bodies.test.js` "setMassProperties: mass alone scales the inertia, every figure given is the body exactly" | Wasm | Wasm |
| RB-13 | `lock_translations`, `lock_rotations`, `enabled_translations`, `enabled_rotations`, `LockedAxes` | yes | yes | DONE: `kernel/tests/integrate.rs` `locks_hold_a_body_on_its_world_axes` | Wasm | Wasm |
| RB-14 | `dominance_group` (-127 to 127) | `dominance` | yes | DONE: `next-events.test.js` "a higher dominance is a wall to a lower one, and nothing to a floor" | Wasm | Wasm |
| RB-15 | `additional_solver_iterations` | yes | yes | DONE: `next-bodies.test.js` "extra passes give an island what a world of that many passes would, and leave the others alone" | Wasm | Wasm |
| RB-16 | `additional_pgs_iterations` | no | none | MISSING, 138.3 | Wasm | Wasm |
| RB-17 | `allow_fast_rotation` | no | none | MISSING, 138.3 | Wasm | Wasm |
| RB-18 | `gyroscopic_forces_enabled` | no | gyroscopic term always on | PARTIAL: term DONE: `kernel/tests/integrate.rs` `a_free_symmetric_top_precesses_at_the_closed_form_rate`; switch MISSING, 138.3 | Wasm | Wasm |
| RB-19 | `enabled` | `enabled` | yes | DONE: `next-events.test.js` "a disabled body leaves the world and comes back; a disabled collider touches nothing" | Wasm | Wasm |
| RB-20 | `user_data` | `userData` | yes | DONE: `next-events.test.js` "a contact filter decides pair by pair" | Wasm | Wasm |
| RB-21 | `add_force`, `add_torque`, `apply_impulse`, `apply_torque_impulse` | yes | yes | DONE: `kernel/tests/integrate.rs` `a_force_reaches_every_substep_and_an_impulse_lands_once` | Wasm | Wasm |
| RB-22 | `add_force_at_point`, `apply_impulse_at_point` | yes (`point`) | yes (`point`) | DONE without a named test; test added in 138.3 | Wasm | Wasm |
| RB-23 | `reset_forces`, `reset_torques`, `user_force`, `user_torque` | `resetForces`, `appliedForce`, `appliedTorque` | same | DONE without a named own-solver test (root: `frames.test.js` "the force and torque left on a body read back until they are reset"); test and `resetTorques` alone added in 138.3 | Wasm | Wasm |
| RB-24 | `velocity_at_point` | no | none | MISSING, 138.3 | Wasm | Wasm |
| RB-25 | `predict_position_using_velocity`, `..._and_forces` | no | none | MISSING, 138.3 | Wasm | Wasm |
| RB-26 | `set_next_kinematic_translation`, `..._rotation`, `next_position` | `setNextPosition`, `setNextRotation` | yes | DONE: `kernel/tests/integrate.rs` `a_kinematic_position_body_lands_on_its_target_and_reports_what_moved_it` | Wasm | Wasm |
| RB-27 | `kinetic_energy`, `gravitational_potential_energy` | no | used inside sleep only | MISSING, 138.3 | Wasm | Wasm |
| RB-28 | `mass`, `invMass`, `principalInertia`, `principalInertiaLocalFrame`, `localCom`, `worldCom` | yes | yes | DONE: `kernel/tests/bodies.rs` `a_tilted_collider_turns_the_principal_frame_with_it` | Wasm | Wasm |
| RB-29 | `effectiveInvMass`, `effectiveAngularInertia`, `effectiveWorldInvInertia` | no | none | MISSING, 138.3 | Wasm | Wasm |
| RB-30 | `recompute_mass_properties_from_colliders` | implicit | `world.updateMass` | DONE: `kernel/tests/bodies.rs` `removing_a_collider_or_adding_mass_recomputes_the_body` | Wasm | Wasm |
| RB-31 | `is_moving`, `is_valid`, `is_dynamic` and the other state reads | partly | partly | MISSING (the rest), 138.3 | Wasm | Wasm |
| RB-32 | `copy_from` | no | none | MISSING, 138.3 | Wasm | Wasm |
| RB-33 | `colliders()`, `numColliders`, `collider(i)` | `colliders` | yes | DONE without a named test; test added in 138.3 | Wasm | Wasm |

## Shapes

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| S-01 | `ball` | `sphere` | `ball` / `sphere` | DONE: `kernel-contacts.test.js` "a ball and a capsule touch the floor through the same contacts" | Wasm | Wasm |
| S-02 | `cuboid` | `box` | yes | DONE: `kernel/tests/sat.rs` `a_box_resting_on_a_box_has_all_four_corners_at_once` | Wasm | Wasm |
| S-03 | `capsule_y` | `capsule` | yes | DONE: `kernel/tests/gjk.rs` `capsules_cross_at_one_point_and_lie_side_by_side_on_two` | Wasm | Wasm |
| S-04 | `capsule_x`, `capsule_z`, `capsule_from_endpoints` | Y only (turn with `rotation`) | Y only | MISSING, 139.1 | Wasm | Wasm |
| S-05 | `segment` | no | none | MISSING, 139.1 | Wasm | Wasm |
| S-06 | `triangle` | no | none | MISSING, 139.1 | Wasm | Wasm |
| S-07 | `halfspace` | `halfSpace` | none | MISSING, 139.1 | Wasm | Wasm |
| S-08 | `cylinder` | yes | `cylinder` (`radius`, `halfHeight` along Y), as a collider and a compound part, with rays, casts and point queries | DONE (126.5): `kernel/tests/revolve.rs` (mass against closed forms and a numeric integral, rays and projections against brute force, a cap, rim or side on a floor, stacks, rest), `tests/next-revolved.test.js` (mass, centre and moments within 1e-5 of Rapier 0.21's; rays, casts and rest against Rapier and an exact f64 surface) | Wasm | Wasm |
| S-09 | `cone` | yes | `cone` (apex at +`halfHeight`), as a collider and a compound part, with rays, casts and point queries | DONE (126.5): the tests of S-08, plus a base, side line or apex on a floor and a ray from 20 to 400 m away within 4 float32 rounding units of its length (`kernel/tests/revolve.rs`) | Wasm | Wasm |
| S-10 | `round_cylinder`, `round_cone` | `borderRadius` on `cylinder` and `cone` | `borderRadius` on `cylinder` and `cone`: the border is a margin on GJK and the expanding polytope, the normal read in closed form from the core's nearest point | DONE (126.5): the tests of S-08; a round shape weighs its border too, where Rapier 0.21 weighs only its core (accepted difference, more correct); Rapier's casts on round cylinders and cones are up to 9.4e-4 m off the exact touch, the own solver's within 1e-5 m (faults for 129) | Wasm | Wasm |
| S-10b | `round_cuboid`, `round_triangle`, `round_convex_hull`, `round_convex_mesh` | `custom` only | none | MISSING, 139.2 | Wasm | Wasm |
| S-11 | `convex_hull(points)` | `convexHull` | Quickhull | DONE: `next-hull.test.js` "every hull holds its points, reaches its farthest ones, and the kernel takes it" | Wasm | Wasm |
| S-12 | `convex_mesh(points, indices)` (convex, no hull step) | no | kernel `addHull(vertices, faces)` | PARTIAL: kernel DONE: `kernel-contacts.test.js` "addHull names what is wrong with a shape"; `Physics` option MISSING, 139.4 | Wasm | Wasm |
| S-13 | `polyline` (3D) | no | none | MISSING, 139.1 | Wasm | Wasm |
| S-14 | `trimesh` | `trimesh` | `trimesh` on `/next` (`KernelWorld.addTrimesh`, the `trimesh` collider option): a tree over the triangles by Wald 2007's binned SAH, one manifold per touching triangle, both sides collide, no mass | DONE (126.2): `kernel/tests/mesh.rs`, `kernel/tests/bvh.rs`, `tests/next-trimesh.test.js`; mesh against mesh gives no contacts (`docs/limits.md`), parity of composite against composite open, 139.3 | Wasm | Wasm |
| S-15 | `TriMeshFlags::FIX_INTERNAL_EDGES` | `fixInternalEdges` | `fixInternalEdges` on `/next`, default false as in Rapier: each edge sorted convex, concave, flat or open from the triangle across it, and a contact normal outside the triangle's Voronoi region snapped or skipped (Catto 2020) | DONE (126.2): `kernel/tests/mesh.rs` `a_box_slides_over_inner_edges_without_catching` (variance 0 with it, 0.91 without), the harness flat slides (ball 4.3e-11, box 1.0e-12 against the bar of 1e-4) | Wasm | Wasm |
| S-16 | `TriMeshFlags` `MERGE_DUPLICATE_VERTICES`, `DELETE_DEGENERATE_TRIANGLES`, `DELETE_DUPLICATE_TRIANGLES`, `DELETE_BAD_TOPOLOGY_TRIANGLES`, `CONNECTED_COMPONENTS`, `HALF_EDGE_TOPOLOGY`, `ORIENTED`, `FIX_INTERNAL_EDGES_TWO_SIDED`, `DEFORMABLE` | no | none | MISSING, 139.3 (`DEFORMABLE` 146.4) | Wasm | Wasm |
| S-17 | trimesh mass for a closed, oriented mesh | no | none | MISSING, 139.3 | Wasm | Wasm |
| S-18 | `heightfield` | `heightfield` | `heightfield` on `/next` (`KernelWorld.addHeightfield`): Rapier's layout, rows along z and columns along x, heights column major, each cell split from (r + 1, c) to (r, c + 1); the kernel keeps the grid's points and finds cells by halving, no tree | DONE (126.3): `kernel/tests/mesh.rs` `a_height_field_meets_shapes_as_the_same_triangles_do` (bit for bit against the same triangles as rows), `tests/next-heightfield.test.js` (300 rays at Rapier's field within 2.2e-6 m; a ramp roll within 0.45 percent of Rapier's); per-cell status (removed cells, zigzag) open, 139.3 | Wasm | Wasm |
| S-19 | `HeightFieldFlags::FIX_INTERNAL_EDGES` | `fixInternalEdges` (root passes Rapier's flag) | `fixInternalEdges`, default false, the trimesh rule with each edge's class worked out from the cell's neighbours | DONE (126.3): `kernel/tests/mesh.rs` `a_ball_and_a_box_cross_a_flat_height_field_with_their_speed_steady` (the box catches without it), the harness flat slides (ball 4.0e-11, box 4.5e-13 against 1e-4); root: `physics.test.js` "trimesh, convex hull and heightfield colliders support resting bodies" | Wasm | Wasm |
| S-20 | `voxels`, `setVoxel`, `combineVoxelStates`, `propagateVoxelChange` | yes | `voxels` on `/next` (`KernelWorld.addVoxels`): cells as boxes, one part per touching cell, exposed-face rule on seams, coupling across grids, growth on `setVoxel`, mass of the cells | DONE (126.5): `kernel/tests/voxel.rs` (the rule, rest, slide across one grid and coupled grids without catching, uncoupled catch, propagate, hole and growth, mass the same as one box, grid on grid, falls through a mesh, ball roll), `tests/next-voxels.test.js` (rest, size, edits, seam, mass, centre and moments, what a grid meets, refusals, all against Rapier 0.21); differences: mass follows an edit at once, rays and casts wait for the queries job | Wasm | Wasm |
| S-21 | `voxels_from_points`, `voxelized_mesh(FillMode)` | no | none | MISSING, 139.4 | Wasm | Wasm |
| S-22 | `compound` | yes | `compound` on `/next` (`KernelWorld.addCompound`): box, sphere, capsule, cylinder, cone and hull parts, each a child row with its own box; one pair per other collider with a part per touching child | DONE (126.4): `kernel/tests/compound.rs` (mass the same bits as the parts as colliders, rest on balls, one pair with a part per ball, against a mesh, stacked compounds, the gap between parts, a sensor, rows freed on removal), `tests/next-compound.test.js` (mass, centre and inertia against Rapier's within 1e-5, rest within 0.01 m of Rapier's, one contact pair); cylinder and cone parts in `kernel/tests/revolve.rs`; rays and casts on compounds are in Q-01 and Q-09 | Wasm | Wasm |
| S-23 | `CompoundFlags::FIX_INTERNAL_EDGES` | no | none | MISSING, 139.3 | Wasm | Wasm |
| S-24 | `convex_decomposition` (V-HACD) | `convexDecomposition` | none | BUILDING 126 (`/decomposition`) | Wasm | Wasm |
| S-25 | `VHACDParameters` each: concavity, alpha, beta, resolution, plane and hull downsampling, fill mode, hull approximation, max hulls; `round_convex_decomposition` | no | none | MISSING (what 126 leaves out), 139.6 | Wasm | Wasm |
| S-26 | `converted_trimesh(MeshConverter)` | no | none | MISSING, 139.4 | Wasm | Wasm |
| S-27 | `Tetrahedron` shape | no | none | MISSING, 139.1 | Wasm | Wasm |
| S-28 | several colliders per body with poses | yes | yes | DONE: `kernel/tests/bodies.rs` `two_balls_make_a_dumbbell_with_the_parallel_axis_inertia` | Wasm | Wasm |
| S-29 | shape reads and setters at run time: `setShape`, `setRadius`, `setHalfExtents`, `setHalfHeight`, `setRoundRadius` | reads only | none | MISSING, 139.5 | Wasm | Wasm |

## Colliders and materials

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| C-01 | collider translation and rotation on the body | `offset`, `rotation` | yes | DONE: `kernel/tests/bodies.rs` `a_tilted_collider_turns_the_principal_frame_with_it` | Wasm | Wasm |
| C-02 | `density`, `mass` | yes | yes | DONE: `next-physics.test.js` "a massless collider adds nothing, and a mass gives the density for the shape" | Wasm | Wasm |
| C-03 | collider `mass_properties` | no | none | MISSING, 139.5 | Wasm | Wasm |
| C-04 | `friction`, `restitution` (defaults 0.5 and 0) | yes | yes | DONE: `next-contacts.test.js` "friction: a block holds below tan t = mu and slides above it" | Wasm | Wasm |
| C-05 | combine rules `Average`, `Min`, `Multiply`, `Max` with precedence | yes | yes | DONE: `next-contacts.test.js` "combine rules: the pair takes the higher rule, max over multiply over min over average" | Wasm | Wasm |
| C-06 | combine rules `ClampedSum`, `GeometricMean` | no | none | MISSING, 140.1 | Wasm | Wasm |
| C-07 | `sensor` | yes | yes | DONE: `next-events.test.js` "sensors fire intersection start and end events and push nothing" | Wasm | Wasm |
| C-08 | collider `enabled` | yes | yes | DONE: `next-events.test.js` "a collider made enabled: false joins switched off" | Wasm | Wasm |
| C-09 | `collision_groups`, `solver_groups` (16 + 16 bits in JS) | yes | yes | DONE: `next-events.test.js` "collision groups decide who collides, solver groups who is solved" | Wasm | Wasm |
| C-10 | 32-group Rust `InteractionGroups`, `InteractionTestMode` `And` / `Or` | no | none | MISSING, 140.2 | Wasm | Wasm |
| C-11 | `active_collision_types` (dynamic, kinematic and fixed pair kinds, six flags) | no | fixed rule set | MISSING, 140.2 | Wasm | Wasm |
| C-12 | `active_events` `COLLISION_EVENTS`, `CONTACT_FORCE_EVENTS` | `events` (collision only) | `events` | PARTIAL: collision DONE: `next-events.test.js` "contact events name both sides, and a collider with events off stays quiet alone"; force opt-in MISSING, 140.1 | Wasm | Wasm |
| C-13 | `active_hooks` per collider | no | one filter for all | MISSING, 140.3 | Wasm | Wasm |
| C-14 | `contact_force_event_threshold` | no | event for every pair with a listener | MISSING, 140.1 | Wasm | Wasm |
| C-15 | `contact_skin` | no | none | MISSING, 140.1 | Wasm | Wasm |
| C-16 | collider `user_data` | no | none | MISSING, 139.5 | Wasm | Wasm |
| C-17 | `position_wrt_parent` reads and setters | reads | none | MISSING, 139.5 | Wasm | Wasm |
| C-18 | `compute_aabb`, `compute_swept_aabb`, `compute_collision_aabb` | no | broad phase holds them | MISSING, 139.5 | Wasm | Wasm |
| C-19 | `volume`, collider `mass`, `density` reads | no | none | MISSING, 139.5 | Wasm | Wasm |
| C-20 | collider queries: `castRay`, `castRayAndGetNormal`, `castShape`, `castCollider`, `projectPoint`, `containsPoint`, `intersectsRay`, `intersectsShape`, `contactCollider`, `contactShape` | `containsPoint` | none | MISSING, 139.5 | Wasm | Wasm |
| C-21 | friction and restitution setters take effect next step | yes | yes | DONE: `next-contacts.test.js` "setFriction reaches the next step and wakes a sleeper it no longer holds" | Wasm | Wasm |

## Events, pairs and hooks

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| E-01 | `CollisionEvent` started and stopped, `SENSOR` flag | `contactstart` and the rest | same | DONE: `kernel/tests/events.rs` `contact_events_begin_on_touching_and_end_on_leaving` | Wasm | Wasm |
| E-02 | `CollisionEventFlags::REMOVED` (stopped event when a collider leaves) | no (a root Limit) | silent on removal | MISSING, 140.5 | Wasm | Wasm |
| E-03 | `ContactForceEvent` total force, magnitude | no | `contactforce` impulse and force | DONE: `kernel/tests/events.rs` `a_resting_stack_presses_with_the_weight_above_each_contact` | Wasm | Wasm |
| E-04 | `ContactForceEvent` `total_force` vector, `max_force_direction`, `max_force_magnitude` | no | magnitudes only | MISSING, 140.1 | Wasm | Wasm |
| E-05 | `EventQueue` drain, auto drain | `on()` listeners | same | DONE differently: `next-events.test.js` "a listener may step: each step gathers into its own list" | Wasm | Wasm |
| E-06 | `contact_pair(a, b)`, `contact_pairs_with`: manifolds, local normals, points, distance, normal and tangent impulses, solver contacts | `touching`, `contactPoints` | `touching`, `contactPoints`, kernel `contacts()` | PARTIAL: basic DONE: `next-contacts.test.js` "a box flat on a floor is pushed at its four corners"; full manifold reads MISSING, 138.5 | Wasm | Wasm |
| E-07 | `intersection_pair`, `intersection_pairs_with` | no | none | MISSING, 138.5 | Wasm | Wasm |
| E-08 | `filter_contact_pair` (skip, solve, or detect without solving) | `contactFilter` (boolean) | same | PARTIAL: boolean DONE: `next-events.test.js` "a contact filter decides pair by pair"; three-way result MISSING, 140.3 | Wasm | Wasm |
| E-09 | `filter_intersection_pair` (sensor pairs, its own hook) | shared with `contactFilter` | shared | MISSING, 140.3 | Wasm | Wasm |
| E-10 | `modify_solver_contacts`: normal, friction, restitution, tangent velocity, anchors, distance, persistent manifold `user_data` (Rust only; JS has no such hook) | no | none | MISSING, 140.4 | Wasm | Wasm |
| E-11 | `update_as_oneway_platform` | no | none | MISSING, 140.4 (3D and 2D) | Wasm | Wasm |
| E-12 | conveyor belt by tangent velocity | no | none | MISSING, 140.4 | Wasm | Wasm |
| E-13 | CCD sensor crossings start and stop events | no | none: the sweep skips sensors | MISSING, 140.5 | Wasm | Wasm |
| E-14 | soft body tear events | no | none | MISSING, 146.1 | Wasm | Wasm |

## Joints

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| J-01 | `FixedJoint` with local frames | `fixed` | yes | DONE: `kernel/tests/joints.rs` `a_fixed_joint_holds_a_heavy_body_rigid` | Wasm | Wasm |
| J-02 | `SphericalJoint` | `spherical` | yes | DONE: `next-joints.test.js` "fixed and spherical joints hold their anchors" | Wasm | Wasm |
| J-03 | spherical joint `limits(axis, [min, max])` per angular axis | no | cone joint (swing ellipse and twist) | BUILDING 126 (per-axis limits come with the generic joint) | Wasm | Wasm |
| J-04 | `RevoluteJoint` with limits and motor | yes | yes | DONE: `next-joints.test.js` "revolute joints respect limits and motors drive them" | Wasm | Wasm |
| J-05 | `PrismaticJoint` with limits and motor | yes | yes | DONE: `next-joints.test.js` "prismatic joints respect limits and position motors" | Wasm | Wasm |
| J-06 | `RopeJoint` `max_distance` | `rope` | yes | DONE: `kernel/tests/joints.rs` `a_rope_is_slack_inside_its_length_and_holds_at_it` | Wasm | Wasm |
| J-07 | rope joint motor (a winch) | no | none | MISSING, 141.1 | Wasm | Wasm |
| J-08 | `SpringJoint` rest length, stiffness, damping | `spring` | yes | DONE: `kernel/tests/joints.rs` `a_spring_settles_at_its_rest_length_plus_the_static_stretch` | Wasm | Wasm |
| J-09 | `spring_model` (`ForceBased` default, `AccelerationBased`) | no | force model | MISSING, 141.1 | Wasm | Wasm |
| J-10 | `PinSlotJoint` | no | none | MISSING, 141.1 | Wasm | Wasm |
| J-11 | `GenericJoint`: locked axes, limit axes, motor axes, `JointAxesMask`, `JointAxis` | `generic` | yes | DONE: `next-bodies.test.js` "a generic joint is the joint its locks make: all six a fixed joint, the linear three a ball joint" | Wasm | Wasm |
| J-12 | generic `coupled_axes` | no | none | MISSING, 141.1 | Wasm | Wasm |
| J-13 | local anchors and local frames | `anchorA/B`, `frameA/B` | yes | DONE: `next-joints.test.js` "frames in place of an axis: the rest pose reads 0, whatever the frames" | Wasm | Wasm |
| J-14 | `setAnchor1/2`, `setLocalFrame1/2`, `setFrameX1/2` after creation, `flip` | no | none | MISSING, 141.2 | Wasm | Wasm |
| J-15 | `contacts_enabled` | yes | yes | DONE: `kernel/tests/joints.rs` `bodies_a_joint_holds_do_not_collide_unless_asked` | Wasm | Wasm |
| J-16 | joint `enabled` | no | rests while a body is disabled | MISSING, 141.2 (per joint) | Wasm | Wasm |
| J-17 | joint `softness` (Hz and damping ratio on locked axes) | no | none | MISSING, 141.2 | Wasm | Wasm |
| J-18 | motor `target_vel`, `target_pos`, `stiffness`, `damping`, `max_force`, `MotorModel` `AccelerationBased` / `ForceBased` | yes | yes | DONE: `next-joints.test.js` "a motor cap holds the torque, and a force motor does not scale with the body" | Wasm | Wasm |
| J-19 | joint `user_data` | no | none | MISSING, 141.2 | Wasm | Wasm |
| J-20 | impulse joint force readback | no | none | MISSING, 141.2 | Wasm | Wasm |
| J-21 | multibody joints (reduced coordinates, tree, loop closed by an impulse joint, cannot be violated) | not wrapped | none | PLANNED 128 (`/articulation`) | Wasm | Wasm |
| J-22 | `MultibodyJointSet::insert_kinematic` (kinematic links) | no | none | MISSING, 128.x (articulation API) | Wasm | Wasm |
| J-23 | multibody `forward_kinematics`, single link and branch, `body_jacobian`, `kinematic_branch`, `apply_displacements` | no | none | MISSING, 128.x (articulation API) | Wasm | Wasm |
| J-24 | multibody generalized velocity and acceleration, joint velocity, damping, armature, joint frictions, DOF inverse inertia, augmented mass | no | none | MISSING, 128.x (articulation API) | Wasm | Wasm |
| J-25 | multibody self contacts on and off | no | none | MISSING, 128.x (articulation API) | Wasm | Wasm |
| J-26 | multibody DOF couplings | no | none | MISSING, 128.x (articulation API) | Wasm | Wasm |
| J-27 | multibody links: `root`, `link`, `links`, `num_links`, `rigid_body_link`, `joint_between`, `attached_bodies` | no | none | MISSING, 128.x (articulation API) | Wasm | Wasm |
| J-28 | multibody `inverse_kinematics` with `InverseKinematicsOption` (damping, max iterations, constrained axes, linear and angular epsilon) | no | none | MISSING, 128.y (inverse kinematics) | Wasm | Wasm |

## Continuous collision

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| CC-01 | bullet CCD against every body kind | `ccd` | conservative advancement after each step against every collider whose fat box meets the path: fixed, kinematic, dynamic and sleeping bodies, every shape, compounds piece by piece; a body stopped on a kinematic body, or a dynamic one without `ccd`, rides with it for the rest of the step | DONE (126.8): `kernel/tests/ccd.rs` (1,000 turning bullets at a box wall, a mesh and a height field; a ball sliding fast on a floor the same bits as without `ccd`; a stopped bullet carried by a kinematic wall; 200 spinning bullets at a wall coming at them), `tests/next-ccd.test.js` (1,000 balls, boxes and capsules at 300 m/s: none reaches the middle plane of a 2 cm wall, a mesh or a height field; 200 spinning bullets at a kinematic wall coming at 20 m/s and at a free dynamic plate: none ends a step past its middle);Rapier's result for 129: Rapier 0.21 with `ccd` on, as a black box through the root entry, on the same 1,000 shots: 974 balls, 189 boxes and 2 capsules end a step with their centre past the far face of the 2 cm box wall (they stop at the touch, then the next step carries them into the wall and its contacts push them out on the far side); 4 boxes pass the two-triangle mesh; none pass the height field; loss for 129: the sweep tests every collider's fat box, with no tree | Wasm | Wasm |
| CC-02 | fast non-bullet bodies swept against fixed colliders by default | Rapier's | speculative contacts as far ahead as each body can move in a step, the sweep only with `ccd`, as in Rapier | DONE (126.8): `kernel/tests/solver.rs` `a_fast_ball_stops_on_the_floor_without_passing_through`; `tests/next-ccd.test.js` shows that without `ccd` fast turning boxes can pass a thin wall | Wasm | Wasm |
| CC-03 | soft CCD (predictive contacts ahead) | no | none | BUILDING 126 | Wasm | Wasm |
| CC-04 | `is_ccd_active` | no | `body.ccdActive` | DONE (126.8): `tests/next-ccd.test.js` (true on a step the sweep checked a fast body, false once it is slow, never on a slow body) | Wasm | Wasm |

## Scene queries

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| Q-01 | `cast_ray` with `solid` | `raycast` | `raycast` with `solid` and `maxDistance` on every shape (ball, box, capsule, cylinder, cone, hull, trimesh, heightfield, voxels, compound) | DONE (126.6): `kernel/tests/query.rs` (closed forms, hull as box, mesh tree, height field and voxel walks and compound against brute force), `tests/next-queries.test.js` (600 random rays on a scene of every shape, solid and hollow, against Rapier 0.21); differences: a solid start inside a ball gives no normal where Rapier gives the ray reversed, and Rapier 0.21 misses a few rays across a height field's cells (2 of 1,200 in the test) where its own ray from the surface confirms the point the own solver finds; loss for 129: the world ray tests every collider in turn (no tree over colliders) | Wasm | Wasm |
| Q-02 | `cast_ray_and_get_normal` | `raycast` (normal) | the hit's `normal` and `point` | DONE (126.6): `kernel/tests/query.rs`, `tests/next-queries.test.js` (normals and points against Rapier 0.21) | Wasm | Wasm |
| Q-03 | `intersect_ray` (all hits, callback may stop) | `raycastAll` | `raycastAll`, nearest first, with `stop` to end the list | DONE (126.6): `tests/next-queries.test.js` (the same colliders in the same order as Rapier 0.21; `stop`) | Wasm | Wasm |
| Q-04 | `project_point` with `is_inside` | `projectPoint` | `projectPoint` with `solid` on every shape, `inside` and the distance in the hit | DONE (126.7): `kernel/tests/cast.rs` (closed forms, boxes and hulls against clamps and brute force, mesh, height field and voxel walks against brute force), `tests/next-shape-queries.test.js` (400 random points, solid and hollow, against Rapier 0.21 within 1e-4 m); Rapier's fault: its hull projections stray up to 1e-3 m along the surface, where the own one holds its f64 projection (Duchi et al. 2008) within 1e-5 m; loss for 129: no tree over colliders, and a voxel projection reads every cell | Wasm | Wasm |
| Q-05 | `project_point_and_get_feature`, ray `FeatureId` | no | none | MISSING, 140.6 | Wasm | Wasm |
| Q-06 | `intersect_point` | `intersectPoint` | `intersectPoint`, every collider holding the point; a trimesh or height field holds none, as in Rapier | DONE (126.7): `tests/next-shape-queries.test.js` (1,200 random points, the same colliders as Rapier 0.21) | Wasm | Wasm |
| Q-07 | `intersect_shape` | `intersectShape` | `intersectShape` with a ball, box, capsule or hull, by GJK on each convex piece | DONE (126.7): `tests/next-shape-queries.test.js` (1,200 random drops: the same colliders as Rapier 0.21, and every height-field answer held to an exact f64 reference); Rapier's fault for 129: its `intersectionsWithShape` never finds a height field overlap with a box, capsule or hull (17 of 30 in the test), which its own cast from there meets at 0 | Wasm | Wasm |
| Q-08 | `intersect_aabb_conservative`, `collidersWithAabbIntersectingAabb` | no | none | MISSING, 140.6 | Wasm | Wasm |
| Q-09 | `cast_shape` | `shapeCast` | `shapeCast` of a ball, box, capsule, cylinder, cone or hull against every shape: GJK ray casting (van den Bergen 2004), sharpened by his closest-point steps from a lower bound | DONE (126.7): `kernel/tests/cast.rs` (closed forms, bisected GJK distance, walks against brute force), `tests/next-shape-queries.test.js` (400 random casts: the same collider and distance as Rapier 0.21 within 1e-4 m, or within 5e-5 m of an exact f64 reference where they differ; the point on both shapes within 1e-5 m); Rapier's faults for 129: long casts stop short by up to about 1e-3 of their length (15 of 236 hits), on a height field even a 1 cm cast by 2e-4 m, and its point is off the query shape on 4 of 236 | Wasm | Wasm |
| Q-10 | `ShapeCastOptions` `target_distance`, `stop_at_penetration`, `compute_impact_geometry_on_penetration`; witnesses and both normals in the hit | `maxDistance` only | `targetDistance`, `stopAtPenetration`, `computeImpactGeometryOnPenetration`; `point`, `normal`, `queryPoint` and `queryNormal` in the hit | DONE (126.7): `kernel/tests/cast.rs` (stop options), `tests/next-shape-queries.test.js` (target distances against Rapier 0.21 and the exact reference; the documented start-in-contact cases) | Wasm | Wasm |
| Q-11 | `cast_shape_nonlinear` (a turning cast) | no | none | MISSING, 140.6 | Wasm | Wasm |
| Q-12 | `QueryFilter` groups, exclude collider, exclude body, predicate; flags `EXCLUDE_FIXED`, `EXCLUDE_KINEMATIC`, `EXCLUDE_DYNAMIC`, `EXCLUDE_SENSORS` | yes | the same, as `groups`, `excludeCollider`, `exclude`, `predicate`, `excludeFixed`, `excludeKinematic`, `excludeDynamic`, `excludeSensors` on every query served | DONE (126.6) for rays: `kernel/tests/query.rs`, `tests/next-queries.test.js` (each option against Rapier 0.21) | Wasm | Wasm |
| Q-13 | flags `EXCLUDE_SOLIDS`, `ONLY_DYNAMIC`, `ONLY_KINEMATIC`, `ONLY_FIXED` | no | `excludeSolids`, `onlyDynamic`, `onlyKinematic`, `onlyFixed` | DONE (126.6) for rays on `/next`: `kernel/tests/query.rs`, `tests/next-queries.test.js`; the root entry still lacks them (140.6) | Wasm | Wasm |
| Q-14 | `propagateModifiedBodyPositionsToColliders` (queries see a moved body before the step) | queries see the last step (2D refreshes) | none | MISSING, 140.6 | Wasm | Wasm |

## Character controller

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| K-01 | `up`, `offset`, `slide`, `max_slope_climb_angle`, `min_slope_slide_angle`, `snap_to_ground`, `autostep` (`max_height`, `min_width`), `apply_impulses_to_dynamic_bodies`, `character_mass` | yes | throws | PLANNED 128 | Wasm | Wasm |
| K-02 | `CharacterLength` `Relative` and `Absolute` | absolute only | none | MISSING, 141.4 | Wasm | Wasm |
| K-03 | `normal_nudge_factor` | no | none | MISSING, 141.4 | Wasm | Wasm |
| K-04 | autostep `include_dynamic_bodies` (3D; 2D wrapper has it) | no | none | MISSING, 141.4 | Wasm | Wasm |
| K-05 | outputs `computedMovement`, `computedGrounded`, `is_sliding_down_slope`, `numComputedCollisions`, `computedCollision(i)` (hit, translation applied and remaining) | `grounded` | none | MISSING, 141.4 | Wasm | Wasm |
| K-06 | query filter on the move (flags, groups, predicate) | predicate | none | PARTIAL: PLANNED 128; flags and groups MISSING, 141.4 | Wasm | Wasm |
| K-07 | `solve_character_collision_impulses` | through `applyImpulsesToDynamicBodies` | none | PLANNED 128 | Wasm | Wasm |

## Vehicle controller

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| V-01 | `DynamicRayCastVehicleController`, `addWheel(position, direction, axle, rest length, radius)`, engine force, steering, brake, `currentVehicleSpeed` | `Vehicle` | none | PLANNED 128 | Wasm | Wasm |
| V-02 | `WheelTuning` each: suspension stiffness, compression, relaxation (damping), max travel, side friction stiffness, friction slip, max suspension force | some | none | PARTIAL: PLANNED 128 for what the root has; the rest MISSING, 141.5 | Wasm | Wasm |
| V-03 | wheel outputs: contact normal and point, forward and side impulse, ground object, hard point, in contact, rotation, suspension force and length | contact, suspension, spin | none | MISSING (the rest), 141.5 | Wasm | Wasm |
| V-04 | `index_up_axis`, `index_forward_axis` | fixed (+Y up, +Z forward) | none | MISSING, 141.5 | Wasm | Wasm |

## PID and PD controllers

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| C-PID-01 | `PidController(kp, ki, kd, axes)`, `PidAxesMask`, linear and angular corrections toward a pose and velocity, `reset_integrals` | not wrapped | none | MISSING, 141.3 | Wasm | Wasm |
| C-PID-02 | `PdController`, `PdErrors` | not wrapped | none | MISSING, 141.3 | Wasm | Wasm |

## Debug rendering, snapshots, determinism

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| D-01 | `debugRender(filterFlags, predicate)` buffers (`vertices`, `colors`) | yes | throws | MISSING, 127.x (3D); 2D PLANNED 127 | lines | lines on compat; W-02 |
| D-02 | `DebugRenderMode` each: collider AABBs, shapes, contacts, solver contacts, impulse joints, multibody joints, pseudo normals, body axes, soft bodies, soft stress, soft volume contacts | shapes, joints | none | MISSING, 127.x (soft modes 146.5) | lines | lines on compat; W-02 |
| D-03 | `DebugRenderStyle`, `DebugColor` | no | none | MISSING, 127.x | lines | lines on compat; W-02 |
| D-04 | `takeSnapshot`, `restoreSnapshot` of the world | not wrapped | `KernelWorld` snapshot | PARTIAL: DONE (kernel): `next-physics.test.js` "a snapshot restores into a world of any size, and its views follow"; `Physics` level PLANNED 128 | Wasm | Wasm |
| D-05 | cross-platform determinism (same bytes on every machine) | Rapier's | hash equal in Node, native, Chromium, Firefox | DONE: `replay.test.js` "10,000 steps through Physics give the hashes on file" | Wasm | Wasm |
| D-06 | parallel results equal to sequential | no | none | PLANNED 131 | Wasm threads | Wasm threads |

## Soft bodies (new in Rapier 0.36)

The root entry never exposed these, so no Margo user loses them at the switch; they come after it as the optional entry `@margoengine/physics/soft`, still part of the parity floor and before any beyond batch.

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| SB-01 | particles, edges, bend edges, dihedrals, cells (triangles in 2D, tetrahedra in 3D), surface, wire, skin, soft frame body | no | none | MISSING, 144.1 | Wasm | Wasm |
| SB-02 | builders `rope`, `cloth`, `cloth_anisotropic`, `cloth_tube`, `cuboid`, `sphere`, `trimesh`, `polyline` | no | none | MISSING, 144.2 | Wasm | Wasm |
| SB-03 | 2D builders `grid`, `polygon`, `disk` | no | none | MISSING, 144.6 | Wasm | Wasm |
| SB-04 | options: pinned particles, softness, particle mass, mass, masses, particle radius, surface collider on or off, linear damping, gravity scale, can sleep, append, add edges, oriented, volume factor, iterations, particle dominance | no | none | MISSING, 144.3 | Wasm | Wasm |
| SB-05 | `SoftBodySolver::Constraints` (default) | no | none | MISSING, 144.1 | Wasm | Wasm |
| SB-06 | particle attachment to rigid bodies, detach, pinning, kinematic particle targets | no | none | MISSING, 144.4 | Wasm | Wasm |
| SB-07 | particle forces and impulses, impulse at a point, radial impulse | no | none | MISSING, 144.4 | Wasm | Wasm |
| SB-08 | soft and rigid contacts, contact stiffening, resweep strain, extra substeps, recovery settings (edge speculation, self stand down, crossing repulsion, recovery pace) | no | none | MISSING, 144.5 | Wasm | Wasm |
| SB-09 | `SoftBodySolver::Fem` with cell models `Volume`, `Corotational`, `NeoHookean`; FEM settings (linear tolerance, max iterations, max dense DOFs) | no | none | MISSING, 145.1 and 145.2 | Wasm | Wasm |
| SB-10 | builders `volumetric`, `volumetric_with`, `volumetric_skinned` | no | none | MISSING, 145.3 | Wasm | Wasm |
| SB-11 | `SoftBodyMaterial`: Young's modulus, Poisson ratio, elastic damping ratio, damping ratio, deformation damping, edge, bend, volume and shape matching softness, tension only | no | none | MISSING, 145.4 | Wasm | Wasm |
| SB-12 | shape matching | no | none | MISSING, 145.5 | Wasm | Wasm |
| SB-13 | self contacts | no | none | MISSING, 145.6 | Wasm | Wasm |
| SB-14 | plasticity: cell and edge yield, creep, max, plastic flow, `reset_plasticity` | no | none | MISSING, 146.1 | Wasm | Wasm |
| SB-15 | tearing and cutting: tear strain, tear force, smoothing, interior strength, max tears a step, min piece, edge tear resistance, `tear_edge`, `tear_cell`, `tear_soft_body`, `cut_soft_body`, tear events | no | none | MISSING, 146.1 and 146.2 | Wasm | Wasm |
| SB-16 | clusters with rigid proxies, cluster split and removal | no | none | MISSING, 146.3 | Wasm | Wasm |
| SB-17 | deformable colliders (`DEFORMABLE` trimesh and polyline), mesh bindings `skinned`, `direct`, `direct_by_position`, skin collision | no | none | MISSING, 146.4 | Wasm | Wasm |
| SB-18 | soft contact modification candidates (edges, vertices, volume patches) | no | none | MISSING, 146.5 | Wasm | Wasm |

## 2D (rapier2d)

| Row | Rapier | Root today (`physics2d`) | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| T-01 | 2D bodies, types, forces, damping, sleep, locks | yes | none | PLANNED 127 | Wasm | Wasm |
| T-02 | `ball`, `cuboid`, `capsule`, `segment`, `convex_polygon`, `polyline` | `circle`, `box`, `capsule`, `segment`, `polygon`, `polyline` | none | PLANNED 127 | Wasm | Wasm |
| T-03 | `triangle`, `round_triangle`, `round_cuboid`, `round_convex_polygon` | no | none | MISSING, 143.1 | Wasm | Wasm |
| T-04 | 2D `heightfield`, `halfspace`, `compound`, `voxels`, `convex_decomposition` | no | none | MISSING, 143.2 | Wasm | Wasm |
| T-05 | `oriented_polyline` (one-sided) | no | none | MISSING, 143.1 | Wasm | Wasm |
| T-06 | 2D fixed, revolute, prismatic, rope and spring joints with limits and motors | yes | none | PLANNED 127 | Wasm | Wasm |
| T-07 | 2D pin-slot and generic joints | no | none | MISSING, 143.3 | Wasm | Wasm |
| T-08 | 2D multibody joints | no | none | MISSING, 143.3 | Wasm | Wasm |
| T-09 | 2D block solver | Rapier's | none | PLANNED 127 | Wasm | Wasm |
| T-10 | 2D queries: ray, point, shape overlap, shape cast, filters | yes | none | PLANNED 127 | Wasm | Wasm |
| T-11 | 2D events, sensors, collision and solver groups, contact filter, dominance, CCD | events, sensors, groups, `ccd` | none | MISSING, 127.y (2D events and filters) | Wasm | Wasm |
| T-12 | 2D character controller, every option and output | most options | none | MISSING, 143.4 | Wasm | Wasm |
| T-13 | 2D debug render | no | none | PLANNED 127 (`/debug`) | lines | lines on compat; W-02 |
| T-14 | 2D snapshot | no | none | PLANNED 127 (`/snapshot`) | Wasm | Wasm |
| T-15 | 2D PID controller (`AngZ` only for angles) | no | none | MISSING, 143.4 | Wasm | Wasm |
| T-16 | 2D `length_unit` | `pixelsPerMeter` | none | PLANNED 127 (keeps `pixelsPerMeter`) | Wasm | Wasm |

## Recipes and the guide's other items

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| G-01 | moving platform (kinematic position body) | yes | yes | DONE: `kernel/tests/solver.rs` `a_moving_platform_carries_what_stands_on_it` | Wasm | Wasm |
| G-02 | one-way platform recipe | no | none | MISSING, 140.4 | Wasm | Wasm |
| G-03 | conveyor recipe | no | none | MISSING, 140.4 | Wasm | Wasm |
| G-04 | SI units | yes | yes | DONE: `kernel/tests/integrate.rs` `free_fall_follows_the_closed_form_and_the_method_s_own_term` | Wasm | Wasm |

## Backends (Scott's WebGL2 rule)

| Row | Need | Today | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- |
| W-01 | every physics browser test also runs with the engine on `webgl2-compat` and on the `webgl` preview backend | WebGPU readback only | MISSING, 142.5 | browser test | browser test |
| W-02 | debug drawing on every backend | `lines` draws nothing on the `webgl` preview | MISSING, 142.5 (fixed in `@margoengine/lines`, the owning package) | lines | lines |

## Where Margo already does more than Rapier

| Row | What | Proof |
| --- | --- | --- |
| M-01 | Determinism is always on, with no feature flag, and holds in Node, native code, Chromium and Firefox; `world.hash` fingerprints every byte | `replay.test.js` "a world that moved one bit gives a different hash: the proof can fail" |
| M-02 | A snapshot is one memory copy and restores into a world of any size | `next-physics.test.js` "a snapshot restores into a world of any size, and its views follow" |
| M-03 | Cone joint with an elliptical swing limit and a twist limit inside the solver; a limb a floor holds past its cone comes to rest | `kernel/tests/joints.rs` `a_limb_a_floor_holds_past_its_cone_rests` |
| M-04 | Spherical rotation motor toward a quaternion target that reads true near half a turn and follows a spinning target without lag | `next-joints.test.js` "a rotation motor follows a target that spins, without lag, given its spin" |
| M-05 | Springs in implicit form, stable at any stiffness | `kernel/tests/joints.rs` `a_spring_keeps_the_frequency_and_decay_of_implicit_euler` |
| M-06 | Anchored static friction (position level), so a block holds exactly below tan t = mu | `kernel/tests/solver.rs` `a_block_slides_only_above_tan_t_equal_to_mu` |
| M-07 | A 50-link chain holds a 1000:1 end mass | `kernel/tests/joints.rs` `a_chain_of_fifty_holds_a_thousand_to_one_end_mass` |
| M-08 | Changing gravity wakes sleepers (Rapier does not); a body whose support goes falls even after its sleep time ran out | `kernel/tests/sleep.rs` `a_body_whose_support_goes_falls_though_its_time_to_sleep_ran_out_long_ago` |
| M-09 | Fixed step with an accumulator and interpolation, allocation-free mesh sync, nested mesh bodies and `follow` | `nested.test.js` "three levels of bodies keep their world poses whatever order they came in" (root; own solver serves the same sync) |
| M-10 | Bodies on meshes in one call with colliders fitted to the geometry | `next-hull.test.js` "a hull without points is the hull of the given geometry, scaled with the mesh" |
| M-11 | `contactforce` with no threshold set-up, in JavaScript; contact modification (E-10) will be in JavaScript, which Rapier's JS lacks | `next-contacts.test.js` "contactforce says how hard a pair pressed: a box at rest reads its weight" |
| M-12 | Coded errors that name the fix, and a world that refuses to go non-finite instead of drifting silently | `next-joints.test.js` "a body that leaves the numbers stops the world and says why" |
| M-13 | 2D in pixels with y down, tile maps merged into outlines with no seam catch, colliders traced from a sprite's alpha | `physics2d.test.js` "a box slides over merged tile seams without losing speed (regression: seams catch bodies)", `outline.test.js` |
| M-14 | Ragdolls from a skeleton with cone and hinge limits, limp and blend back, balance and get-up (`@margoengine/ragdoll`) | `packages/ragdoll/tests` |
| M-15 | No peer install and no 1.6 MB download: the kernel ships inside the package; its size is measured in batch 129, never estimated | `kernel-blueprint.test.js` |

# Part 2: Beyond Rapier

Every feature here is an optional, tree-shakable entry or package, never core and never a cost for an app that does not import it. Size and speed claims are measured. Engines named: Jolt, PhysX 5, Bullet (with pybullet), MuJoCo, Havok, Box2D v3 and Unreal Chaos, from their public docs and feature lists only; a name marked (u) was not confirmed from a fetched page and must be checked before any public claim. Papers are to be fetched and read in full by the job that builds the row; a DOI marked (u) must be checked first. "Batch" is the beyond batch that owns the row (147 to 158). Row ids never change once given, so a few numbers are unused. The fit columns say how each backend runs it; "GPU" rows run in WebGPU compute and, on WebGL2, in the Wasm kernel or a render-to-texture pass, with the same results within the same tolerances.

## Rigid-body and collision extras

| Row | Feature | Who has it | Paper | WebGPU | WebGL2 | Batch |
| --- | --- | --- | --- | --- | --- | --- |
| X-01 | Speculative contacts as a general CCD mode | Box2D v3, PhysX, Jolt (u) | Catto, "Continuous Collision", GDC 2013 | Wasm | Wasm | 157.1 |
| X-02 | Sweep TOI substepping for any convex pair (conservative advancement) | Box2D v3, Jolt, Bullet, PhysX | Mirtich, PhD thesis, UC Berkeley 1996; Tang, Kim, Manocha, "C2A: Controlled Conservative Advancement", ICRA 2009 | Wasm | Wasm | 157.1 |
| X-03 | Signed distance field collision (mesh as SDF, dynamic concave bodies) | PhysX (GPU) | Macklin, Erleben, Müller et al., "Local Optimization for Robust Signed Distance Field Collision", PACMCGIT 3(1) 2020, doi 10.1145/3384538 | GPU compute | Wasm (accepted difference: slower on large meshes) | 157.2 |
| X-04 | SDF generation from a mesh | PhysX | Bærentzen and Aanæs, "Signed Distance Computation Using the Angle Weighted Pseudonormal", IEEE TVCG 11(3) 2005 | GPU compute | Wasm or render-to-texture | 157.2 |
| X-05 | Dynamic concave triangle mesh bodies (GImpact style) | Bullet | Ericson, "Real-Time Collision Detection", Morgan Kaufmann 2005 | Wasm | Wasm | 157.2 |
| X-06 | Tapered capsule, multi-sphere shape, scaled and offset decorator shapes | Jolt, Bullet | Hubbard, "Approximating Polyhedra with Spheres for Time-Critical Collision Detection", ACM TOG 15(3) 1996 | Wasm | Wasm | 157.3 |
| X-07 | Mutable compound (add and remove parts without rebuilding) | Jolt | Bittner, Hapala, Havran, "Incremental BVH Construction for Ray Tracing", Computers and Graphics 2015 | Wasm | Wasm | 157.3 |
| X-08 | Rolling resistance and tangent speed on materials | Box2D v3, Bullet, Jolt | Box2D v3 docs (behaviour); Catto, "Iterative Dynamics with Temporal Coherence", GDC 2005 | Wasm | Wasm | 157.4 |
| X-09 | Custom combine callback for friction and restitution | Jolt | none needed | Wasm | Wasm | 157.4 |
| X-10 | Body move events and joint force threshold events | Box2D v3, MuJoCo sensors | none needed | Wasm | Wasm | 157.4 |
| X-11 | Batched ray queries for thousands of rays (sensors, audio, AI) | Bullet, PhysX | Wald et al., "Embree", ACM TOG 33(4) 2014 for packet traversal | GPU compute over the BVH | Wasm (accepted difference: slower above 100k rays) | 157.5 |
| X-12 | Closest points between two shapes as a public query | Bullet, Jolt | Montanari, Petrinic, Barbieri, "Improving the GJK Algorithm", ACM TOG 36(3) 2017 | Wasm | Wasm | 157.5 |
| X-88 | Ray distance sensor: a few rays cast from a body each step, range and hit returned, no noise model | Bullet (batched rays), MuJoCo (rangefinder) | none needed | Wasm | Wasm | parity 141.7 |

## Joints, constraints and interaction

| Row | Feature | Who has it | Paper | WebGPU | WebGL2 | Batch |
| --- | --- | --- | --- | --- | --- | --- |
| X-13 | Mouse or drag joint (pick and drag a body with a soft spring) | Box2D v3, Bullet picking | Catto, "Soft Constraints", GDC 2011 | Wasm | Wasm | 147.1 |
| X-14 | Breakable joints (break at a force or torque) with an event | Jolt, PhysX, Bullet | none needed; threshold on the solved impulse | Wasm | Wasm | 147.1 |
| X-15 | Gear joint | Jolt, Bullet | Baraff, "Linear-Time Dynamics using Lagrange Multipliers", SIGGRAPH 1996 | Wasm | Wasm | 147.2 |
| X-16 | Rack and pinion joint | Jolt | Baraff 1996 | Wasm | Wasm | 147.2 |
| X-17 | Pulley joint | Jolt, Box2D (v2) | Baraff 1996 | Wasm | Wasm | 147.2 |
| X-18 | Wheel joint (suspension spring, motor, steering) | Box2D v3, Bullet hinge2 | Catto, "Soft Constraints", GDC 2011 | Wasm | Wasm | 147.3 |
| X-19 | Motor joint (drive a body toward a relative pose, capped force) | Box2D v3 | Catto 2011 | Wasm | Wasm | 147.3 |
| X-20 | Weld joint with linear and angular softness in Hz and damping ratio | Box2D v3, Jolt | Catto 2011 | Wasm | Wasm | 147.3 |
| X-21 | Path constraint (body follows a spline, with motor) | Jolt | Farin, "Curves and Surfaces for CAGD", 5th ed. 2002 | Wasm | Wasm | 147.4 |
| X-22 | Distance joint with min and max and spring | Jolt, Box2D v3, PhysX | Catto 2011 | Wasm | Wasm | 147.4 |
| X-23 | Universal joint and swing-twist joint with D6 style drives | PhysX, Bullet, Jolt | Baerlocher and Boulic, "Parametrization and Range of Motion of the Ball-and-Socket Joint", 2000; Dobrowolski, arXiv 1506.05481, 2015 | Wasm | Wasm | 147.4 |
| X-24 | Explosion and radial impulse fields, wind fields | Chaos fields, Box2D v3 (u) | none needed; field sampled per body | Wasm (GPU for many bodies in 155) | Wasm | 147.5 |
| X-25 | Motor modes off, velocity, position, position and velocity, in frequency and damping form | Jolt, PhysX drives | Tan, Liu, Turk, "Stable Proportional-Derivative Controllers", IEEE CG&A 2011 | Wasm | Wasm | 147.5 |

## Cloth and soft bodies at scale

Parity soft bodies (144 to 146) run on the Wasm kernel. These rows add GPU paths and newer methods.

| Row | Feature | Who has it | Paper | WebGPU | WebGL2 | Batch |
| --- | --- | --- | --- | --- | --- | --- |
| X-26 | XPBD cloth and soft bodies on the GPU (graph coloured constraints) | PhysX PBD, Jolt soft body (CPU), Chaos cloth | Macklin, Müller, Chentanez, "XPBD", MIG 2016, doi 10.1145/2994258.2994272; Fratarcangeli and Pellacini, "Scalable Partitioning for Parallel Position Based Dynamics", CGF 34(2) 2015 | GPU compute | Wasm kernel, same results within tolerance (accepted difference: slower above about 10k particles, measured) | 148.1 |
| X-27 | Vertex Block Descent solver for cloth and volumes | research | Chen, Macklin, Yuksel et al., "Vertex Block Descent", ACM TOG 43(4) 2024 (doi u) | GPU compute | Wasm | 148.2 |
| X-28 | Wind and aerodynamic drag and lift on cloth triangles | Bullet soft body aero, Chaos cloth | Keckeisen, Kimmerle et al., "Modelling Effects of Wind Fields in Cloth Animations", WSCG 2004 (u) | GPU compute | Wasm | 148.3 |
| X-29 | Cloth self collision and cloth against rigid with friction | PhysX, Chaos cloth | Bridson, Fedkiw, Anderson, "Robust Treatment of Collisions, Contact and Friction for Cloth Animation", SIGGRAPH 2002 | GPU compute (spatial hash) | Wasm | 148.4 |
| X-30 | Long range attachments (tethers) for inextensible cloth | Chaos cloth, PhysX (u) | Kim, Chentanez, Müller, "Long Range Attachments", SCA 2012 | GPU compute | Wasm | 148.3 |
| X-31 | Skinned cloth (capes and skirts tied to a skeleton with max distance) | Jolt, Chaos cloth | Müller et al., "Meshless Deformations Based on Shape Matching", SIGGRAPH 2005 | GPU compute | Wasm | 148.5 |
| X-32 | Pressure soft bodies (balloons, inflatables) | Jolt, PhysX, Bullet | Matyka and Ollila, "Pressure Model of Soft Body Simulation", SIGRAD 2003 | GPU compute | Wasm | 148.5 |
| X-33 | Projective dynamics solver | research | Bouaziz, Martin, Liu, Kavan, Pauly, "Projective Dynamics", ACM TOG 33(4) 2014, doi 10.1145/2601097.2601116 | Wasm (global solve) | Wasm | 148.6 |
| X-34 | Stable Neo-Hookean flesh | Chaos flesh (u), Bullet | Smith, de Goes, Kim, "Stable Neo-Hookean Flesh Simulation", ACM TOG 37(2) 2018 | GPU compute | Wasm | 148.6 |

## Buoyancy and water

| Row | Feature | Who has it | Paper | WebGPU | WebGL2 | Batch |
| --- | --- | --- | --- | --- | --- | --- |
| X-35 | Buoyancy from the exact submerged volume of every shape, with drag | Jolt | Archimedes; Catto, "Exact Buoyancy for Polyhedra", Game Programming Gems 6, 2006 | Wasm | Wasm | PLANNED 131 (buoyancy), extended in 149.1 |
| X-36 | Coupling to `@margoengine/water` waves: bodies float on the rendered sea | Chaos water (u) | Tessendorf, "Simulating Ocean Water", SIGGRAPH course notes 2001 | wave heights read back from the water package or evaluated on the CPU from the same spectrum | same, CPU spectrum | 149.2 |
| X-37 | Boats: hull pressure forces per triangle, wake | Chaos (u) | Kerner, "Water Interaction Model for Boats in Video Games", Gamasutra 2015; Fossen, "Handbook of Marine Craft Hydrodynamics", Wiley 2011 | Wasm | Wasm | 149.3 |
| X-38 | Interactive water surface that bodies disturb (height field waves) | Havok (u) | Yuksel, House, Keyser, "Wave Particles", ACM TOG 26(3) 2007 | GPU compute | render-to-texture height field | 149.4 |
| X-39 | Wind and current fields that push floating bodies | Chaos fields | none needed | Wasm | Wasm | 149.5 |

## Destruction

| Row | Feature | Who has it | Paper | WebGPU | WebGL2 | Batch |
| --- | --- | --- | --- | --- | --- | --- |
| X-40 | Voronoi pre-fracture of a mesh into convex pieces | Chaos destruction, PhysX Blast | Raghavachary, "Fracture Generation on Polygonal Meshes Using Voronoi Polygons", SIGGRAPH Sketches 2002 | Wasm | Wasm | PLANNED 131 (fracture), extended in 150.1 |
| X-41 | Runtime fracture by volumetric approximate convex decomposition | research | Müller, Chentanez, Kim, "Real Time Dynamic Fracture with Volumetric Approximate Convex Decompositions", ACM TOG 32(4) 2013 | Wasm | Wasm | 150.2 |
| X-42 | Connection graph with strain thresholds, clusters, anchors | Chaos, PhysX Blast | Parker and O'Brien, "Real-Time Deformation and Fracture in a Game Environment", SCA 2009 | Wasm | Wasm | 150.3 |
| X-43 | Damage from impulses and fields, debris lifetime and sleep | Chaos | Parker and O'Brien 2009 | Wasm | Wasm | 150.4 |
| X-44 | Tearing cloth and cracking thin shells | PhysX (u) | Pfaff, Narain, de Joya, O'Brien, "Adaptive Tearing and Cracking of Thin Sheets", ACM TOG 33(4) 2014 | Wasm | Wasm | 150.5 |

## Vehicles

| Row | Feature | Who has it | Paper | WebGPU | WebGL2 | Batch |
| --- | --- | --- | --- | --- | --- | --- |
| X-45 | Wheel collider with a shape-cast wheel (not one ray) | Jolt, PhysX vehicles | Rill, "Road Vehicle Dynamics", CRC 2011 | Wasm | Wasm | 151.1 |
| X-46 | Pacejka magic formula tyres | PhysX vehicles (u), Chaos vehicles (u) | Pacejka and Bakker, "The Magic Formula Tyre Model", Vehicle System Dynamics 21 1992; Pacejka, "Tire and Vehicle Dynamics", 3rd ed. 2012 | Wasm | Wasm | 151.2 |
| X-47 | Brush tyre model | research | Svendenius, "Tire Modeling and Friction Estimation", PhD, Lund 2007 | Wasm | Wasm | 151.2 |
| X-48 | Drivetrain: engine torque curve, clutch, gearbox, differentials, anti-roll bars | Jolt, PhysX, Chaos | Rill 2011; Milliken and Milliken, "Race Car Vehicle Dynamics", SAE 1995 | Wasm | Wasm | 151.3 |
| X-49 | Tracked vehicles | Jolt | Wong, "Theory of Ground Vehicles", 4th ed. Wiley 2008 | Wasm | Wasm | 151.4 |
| X-50 | Motorcycles (lean and counter-steer) | Jolt | Sharp, "The Stability and Control of Motorcycles", J. Mech. Eng. Sci. 1971 | Wasm | Wasm | 151.5 |

## Ropes, rods and cables

| Row | Feature | Who has it | Paper | WebGPU | WebGL2 | Batch |
| --- | --- | --- | --- | --- | --- | --- |
| X-51 | Cosserat rods (bend and twist, position and orientation based) | research | Kugelstadt and Schömer, "Position and Orientation Based Cosserat Rods", SCA 2016 | GPU compute for many rods | Wasm | 152.1 |
| X-52 | Discrete elastic rods | research | Bergou, Wardetzky et al., "Discrete Elastic Rods", ACM TOG 27(3) 2008 | Wasm | Wasm | 152.2 |
| X-53 | Rope against rigid bodies with friction, wrapping around pegs | PhysX (u), Bullet (u) | Bergou 2008; Sueda, Kaufman, Pai, "Musculotendon Simulation for Hand Animation", ACM TOG 27(3) 2008 | Wasm | Wasm | 152.3 |
| X-54 | Inextensible chains and rods by strain limiting | PBD engines | Goldenthal et al., "Efficient Simulation of Inextensible Cloth", ACM TOG 26(3) 2007 | GPU compute | Wasm | 152.4 |
| X-55 | 2D ropes | Box2D (u) | Kugelstadt 2016 reduced to 2D | Wasm | Wasm | PLANNED 131 (2D ropes), extended in 152.5 |

## Fluids and particles

| Row | Feature | Who has it | Paper | WebGPU | WebGL2 | Batch |
| --- | --- | --- | --- | --- | --- | --- |
| X-56 | Position based fluids | PhysX PBD particles | Macklin and Müller, "Position Based Fluids", ACM TOG 32(4) 2013, doi 10.1145/2461912.2461984 | GPU compute | render-to-texture passes over a particle texture, or Wasm (accepted difference: far fewer particles at the same frame time, measured) | 153.1 |
| X-57 | SPH and divergence-free SPH | research | Müller, Charypar, Gross, "Particle-Based Fluid Simulation for Interactive Applications", SCA 2003; Bender and Koschier, "Divergence-Free SPH", IEEE TVCG 23(3) 2017 | GPU compute | render-to-texture or Wasm | 153.2 |
| X-58 | Two-way rigid and fluid coupling with boundary particles | PhysX | Akinci et al., "Versatile Rigid-Fluid Coupling for Incompressible SPH", ACM TOG 31(4) 2012 | GPU compute with readback of body forces | Wasm | 153.3 |
| X-59 | Viscosity, surface tension, vorticity confinement | PhysX | Akinci, Akinci, Teschner, "Versatile Surface Tension and Adhesion for SPH Fluids", ACM TOG 32(6) 2013 | GPU compute | render-to-texture or Wasm | 153.4 |
| X-60 | Unified particles: granular sand, cloth, rigid clusters in one solver | PhysX (Flex lineage) | Macklin, Müller, Chentanez, Kim, "Unified Particle Physics for Real-Time Applications", ACM TOG 33(4) 2014 | GPU compute | Wasm | 153.5 |
| X-61 | Screen-space fluid rendering | PhysX demos (u) | van der Laan, Green, Sainz, "Screen Space Fluid Rendering with Curvature Flow", I3D 2009 | GPU render | WebGL2 render (same passes) | 153.6 |

## Characters and ragdolls

| Row | Feature | Who has it | Paper | WebGPU | WebGL2 | Batch |
| --- | --- | --- | --- | --- | --- | --- |
| X-62 | Virtual character: platform velocity inherited, push forces, stick to stairs, inner body for other bodies to hit, contact listener | Jolt | Fauerby, "Improved Collision Detection and Response", 2003 | Wasm | Wasm | 154.1 |
| X-63 | Dynamic character (a rigid body kept upright) | Jolt | Tan, Liu, Turk 2011 | Wasm | Wasm | 154.2 |
| X-64 | Powered ragdoll driven to an animation pose | Jolt, Chaos physical animation | Tan, Liu, Turk 2011; Peng et al., "DeepMimic", ACM TOG 37(4) 2018 (as the pose-tracking reference) | Wasm | Wasm | 154.3 (with `@margoengine/ragdoll`) |
| X-65 | Character mass ratios and pushing rules | Jolt | none needed | Wasm | Wasm | 154.1 |

## Articulation dynamics

The standard floor every physics engine with multibodies ships, built here on the `/articulation` entry.

| Row | Feature | Who has it | Paper | WebGPU | WebGL2 | Batch |
| --- | --- | --- | --- | --- | --- | --- |
| X-66 | Inverse dynamics (recursive Newton-Euler) | Bullet, MuJoCo | Walker and Orin, "Efficient Dynamic Computer Simulation of Robotic Mechanisms", J. Dyn. Sys. Meas. Control 104(3) 1982 | Wasm | Wasm | 156.1 |
| X-67 | Mass matrix and Jacobian queries | Bullet, MuJoCo | Featherstone, "Rigid Body Dynamics Algorithms", Springer 2008 | Wasm | Wasm | 156.2 |

## Solvers, scale and stepping

| Row | Feature | Who has it | Paper | WebGPU | WebGL2 | Batch |
| --- | --- | --- | --- | --- | --- | --- |
| X-73 | GPU rigid solver for large scenes (graph colouring, soft step) | PhysX GPU | Macklin et al., "Small Steps in Physics Simulation", SCA 2019; Fratarcangeli and Pellacini 2015 | GPU compute | Wasm kernel, same results within tolerance (accepted difference: CPU speed) | 155.1 |
| X-74 | Augmented Vertex Block Descent for rigid bodies | research | Giles, Diaz, Yuksel, "Augmented Vertex Block Descent", ACM TOG 44(4) 2025 (doi u) | GPU compute | Wasm | 155.2 |
| X-75 | GPU broad phase | PhysX | Liu et al., "Real-Time Collision Culling of a Million Bodies on Graphics Processing Units", ACM TOG 29(6) 2010 | GPU compute | Wasm SAP | 155.3 |
| X-76 | Non-smooth Newton solver for stiff rigid and deformable scenes | research | Macklin et al., "Non-Smooth Newton Methods for Deformable Multi-Body Dynamics", ACM TOG 38(5) 2019 | GPU compute | Wasm | 155.4 |
| X-77 | Substepping choices: per-island substeps, adaptive substeps by mass ratio | PhysX TGS, Box2D v3 | Macklin et al. 2019 | Wasm | Wasm | 155.5 |
| X-78 | Implicit integration of stiff springs (whole system) | MuJoCo implicit, Bullet | Baraff and Witkin, "Large Steps in Cloth Simulation", SIGGRAPH 1998 | Wasm | Wasm | 155.5 |
| X-79 | Double precision large worlds (positions in f64, solver relative) | Jolt, Box2D v3, Bullet | Goldberg, "What Every Computer Scientist Should Know About Floating-Point Arithmetic", ACM Computing Surveys 1991 | Wasm (WebGPU has no f64) | Wasm | parity 142.2, extended in 158.1 |
| X-80 | Threads over islands with identical results | Jolt, Box2D v3, PhysX | Erleben, PhD thesis, Copenhagen 2005 (islands) | Wasm threads | Wasm threads | PLANNED 131, extended in 158.2 |

## Determinism, netcode and tooling

| Row | Feature | Who has it | Paper | WebGPU | WebGL2 | Batch |
| --- | --- | --- | --- | --- | --- | --- |
| X-81 | Rollback with cheap snapshots and state diffs for `@margoengine/netcode` | Jolt SaveState, Box2D v3 | Fiedler, "Deterministic Lockstep", Gaffer On Games 2014; Pusch, "GGPO" docs | Wasm | Wasm | 158.3 |
| X-82 | Snapshot interpolation and state sync for server physics | Chaos networked physics (u) | Fiedler, "Snapshot Interpolation", Gaffer On Games 2014 | Wasm | Wasm | 158.3 |
| X-83 | Determinism across thread counts and across WebGPU and WebGL2 backends | Jolt, Box2D v3 | Fiedler, "Floating Point Determinism", Gaffer On Games 2010 | Wasm | Wasm | 158.4 |
| X-84 | Record and replay debugger (step through a recorded run) | Chaos visual debugger, Jolt recorder | none needed | inspector panel | inspector panel | 158.5 |
| X-85 | Profiler with per-stage, per-island timings in `@margoengine/inspector` | Jolt, Box2D v3 | none needed | Wasm | Wasm | 158.5 |
| X-86 | Binary save of shapes (hulls, BVHs, decompositions) to skip rebuilds | Jolt, Bullet, PhysX | none needed | Wasm | Wasm | 158.6 |
| X-87 | Model formats: URDF and MJCF (parity 141.6), SDF format | Bullet, MuJoCo | SDFormat specification, sdformat.org | Wasm | Wasm | 158.6 |

## Summary

Counted from the rows on 2026-11-07, one count a row by the first word of its Status cell. Update the counts in the same push as any row.

| Part | Rows | DONE | PARTIAL | BUILDING 126 | PLANNED 127 to 131 | MISSING, now owned | N/A |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1, Rapier parity | 251 | 61 | 19 | 21 | 14 | 132 | 4 |
| 2, beyond Rapier | 83 | 0 | 0 | 0 | 4 (extended later) | 79 | 0 |

Margo already does more than Rapier in 15 rows (M-01 to M-15). The missing parity rows are owned by four extra jobs added to batches 127 and 128 (3D debug drawing, 2D events and filters, the multibody API, multibody inverse kinematics) and by batches 138 to 146. Part 2 is owned by batches 147 to 158 (60 jobs; the parity batches 138 to 146 hold 52 jobs, plus the four extra jobs in 127 and 128); 4 of its rows extend what batch 131 already plans 1 (X-79) extends parity job 142.2, and 1 (X-88) is parity job 141.7.

## Order

1. **126 first** (being built): shapes, queries and CCD close the most rows at once.
2. **127 and 128 next**, as planned, with four extra jobs added: 127.x 3D `debugRender` with every mode (the root has it, so the switch needs it), 127.y 2D events and filters (the 2D root has them); 128.x the articulation API and 128.y multibody inverse kinematics (Rapier's multibody surface, which belongs with `/articulation`).
3. **138 to 143, the kernel parity batches, before 129.** Batch 129 is the parity gate and the benchmark matrix, so it must run on the full feature set; benchmarking first would measure a kernel that later grows. 138 world and solver options, 139 shapes, 140 materials, filters, hooks and queries, 141 joints and controllers, 142 SIMD, f64, BVH strategies, block solver and the WebGL2 tests, 143 the 2D rows.
4. **129, 130, 131** as planned: gate, switch, after.
5. **144 to 146, soft bodies, after the switch.** The root entry never exposed Rapier's soft bodies, so no user loses them at the switch, and the solver they need is a separate entry (`/soft`). They are still parity and come before any beyond batch.
6. **Beyond, 147 to 158, by what three.js users want most.** three.js has no physics, so its users bring cannon-es, Rapier or @react-three/rapier, and what they build is games, product scenes and showpieces. In that order of demand: interaction and joints (147: drag joint, breakable and mechanical joints, every one a three.js user asks for in the first week); cloth and soft bodies at scale (148: flags, capes and squishy things are the most shown physics demos); buoyancy and water (149: Margo already has water, and floating is the first thing people try on it); destruction (150); vehicles with real tyres (151); ropes and rods (152); fluids (153: loved, but heavy and GPU first); characters and powered ragdolls (154); large scenes on the GPU (155: thousands of bodies, an instancing showcase); articulation dynamics (156: inverse dynamics, the mass matrix and Jacobians, the floor every engine with multibodies ships); collision extras (157); scale, netcode and tooling (158). 131's fracture, buoyancy, 2D ropes and threads stay where they are; 149, 150, 152 and 158 extend them.
