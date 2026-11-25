# Rapier 2D parity audit: page by page

Scott, 2026-11-24: "I want this physics engine to be as good or better than Rapier and have all the same features or more." That covers `@margoengine/physics2d`. This file audits it against Rapier's published JavaScript user guide for the 2D build (`@dimforge/rapier2d`, JS guide 0.21 at rapier.rs/docs/user_guides/javascript), one guide page at a time. Only published pages were read; no file under `node_modules/@dimforge` and no Rapier source. The pages are Getting started, Rigid-bodies, Colliders, Joints, Joint constraints, Soft-bodies, Controllers (character, vehicle, PID), Scene queries, Advanced collision-detection (events, the contact and intersection graphs, hooks, CCD), Debug-renderer, Serialization and Determinism. The guide has no separate pages for integration parameters, simulation structures or testbeds; the integration parameters are listed in the 3D audit's rows P-01 to P-33 of [rapier-parity.md](rapier-parity.md), which apply to 2D as well.

A row is DONE only when a named test exercises the capability. A row without one is a GAP: it is built, with its test, before it is called done. Statuses: DONE, GAP (nothing built or no test), PARTIAL (part DONE, the rest named). Tests are in `packages/physics2d/tests` unless a path says otherwise. Rapier's names are the guide's own; Margo's are the 2D facade's (`Physics2D`, `Body2D`, `Collider2D`, `Joint2D`).

Found while auditing: the 2D facade had no way to lock rotation after creation, no `resetTorques`, no force at a point, and no setters for the collision-type, event and contact-force settings of a collider (all built and tested since, rows R2-11, R2-13, R2-16, C2-16 and C2-17), and the character controller's slope, autostep, snap and push options had no test (K2-02 to K2-07; a slope past the climb limit was slid up like a ramp, fixed). Still missing: `Body2D.enabled`, collider combine rules and the other collider setters, no all-hits ray, no shape-cast target distance or witness points, no intersection hook or intersection graph query, no query filter for the character controller, and none of the integration parameters. The 2D guide has a Soft-bodies page that covers 2D (ropes, grids, polygons, disks, polylines, trimeshes and volumetric bodies, the constraints solver and the FEM solver): none of it exists yet.

## Rigid-bodies page

| Row | Rapier 2D | Margo 2D | Status |
| --- | --- | --- | --- |
| R2-01 | `RigidBodyDesc.fixed`, `dynamic`, `kinematicVelocityBased`, `kinematicPositionBased`, `RigidBodyType` | `type` on `addBody`, `setType`, `retype` | DONE: `kernel-features.test.js` "body setters, setType, projectPoint, intersectionsWithBox, contactPairs and the character's hits" |
| R2-02 | `setTranslation`, `setRotation` (angle), `wakeUp` flag | `teleport(position, rotation)` | DONE: `physics2d.test.js` "interpolation blends the last two steps and takes the short way round an angle" |
| R2-03 | `setLinvel`, `setAngvel` | `linearVelocity`, `angularVelocity` setters | DONE: `kernel-features.test.js` "body setters, setType, projectPoint, ..." |
| R2-04 | `setGravityScale`, `World.gravity` | `gravityScale`, `Physics2D.gravity` | DONE: `physics2d.test.js` "gravity changes wake sleeping bodies (regression: they floated in the old field)" |
| R2-05 | `setCanSleep`, `wakeUp`, sleeping | `canSleep`, `wakeUp`, `sleep`, `sleeping` | DONE: `kernel-features.test.js` "forces act every step until reset; impulses at a point spin; sleep and wake" |
| R2-06 | `setCcdEnabled` / `enableCcd` | `ccd` | DONE: `kernel-features.test.js` "continuous collision stops a fast body at a thin wall" |
| R2-07 | `setSoftCcdPrediction` | `softCcd` | DONE: `kernel-features.test.js` "soft CCD holds a fast body at a thick wall without a sweep" |
| R2-08 | `IntegrationParameters.maxCcdSubsteps` (0 turns CCD off) | `physics.setSolver({ maxCcdSubsteps })` | DONE: `kernel/tests/ccd.rs` `more_ccd_substeps_carry_a_ball_on_after_each_impact_between_two_walls`, `each_ccd_impact_leaves_the_speed_the_restitution_says`, `a_ccd_impact_gives_the_wall_friction_and_the_ball_its_coulomb_tangential_speed`, `a_ccd_impact_with_a_dynamic_body_conserves_momentum_and_gives_it_the_elastic_speeds`; `ccd2d.test.js` "the limit reads back, defaults to 1, and takes only whole numbers from 0 to 65535", "more impacts a step carry a ball on between two walls: 0 goes through, 1 stops at the first, 4 comes back" |
| R2-09 | `setNextKinematicTranslation`, `setNextKinematicRotation` | `moveTo(position, rotation)` | DONE: `kernel-features.test.js` "body setters, setType, projectPoint, ..." |
| R2-10 | `addForce`, `addTorque` | `applyForce`, `applyTorque` | DONE: `kernel-features.test.js` "forces act every step until reset; impulses at a point spin; sleep and wake" |
| R2-11 | `addForceAtPoint` | `applyForceAtPoint` | DONE: `dynamics2d.test.js` "a force at a point pushes by F / m and turns by r x F / I, and resetTorques keeps the push"; against Rapier 2D: `oracle-rapier.test.js` "a force at a point, a reset torque and a locked rotation turn a body as Rapier 2D does" |
| R2-12 | `applyImpulse`, `applyTorqueImpulse`, `applyImpulseAtPoint` | same names | DONE: `kernel-features.test.js` "forces act every step until reset; impulses at a point spin; sleep and wake" |
| R2-13 | `resetForces`, `resetTorques` | `resetForces`, `resetTorques` | DONE: `dynamics2d.test.js` "a force at a point pushes by F / m ..." (a torque reset keeps the force), and the Rapier 2D comparison above |
| R2-14 | `setAdditionalMass` | `additionalMass` | DONE: `kernel-features.test.js` "debugRender gives lines with colour codes; additionalMass adds to the mass" |
| R2-15 | `setAdditionalMassProperties(mass, centre, inertia)` | `body.setAdditionalMassProperties(mass, centre, inertia)` | DONE: `mass2d.test.js` "an added solid joins the colliders by the parallel axis theorem about the combined centre"; `kernel/tests/bodies.rs` `an_added_solid_joins_the_shapes_by_the_parallel_axis_theorem` |
| R2-16 | `lockTranslations(locked)`, `lockRotations(locked)` after creation | `lockTranslation(x, y)`, `lockRotation(locked)`, `rotationLocked`, and the `lockRotation` option | DONE: `shapes-more.test.js` "lockTranslation holds an axis, follows a teleport and can be freed"; `dynamics2d.test.js` "a locked rotation holds the angle against torque and impulse, and frees again"; against Rapier 2D in the comparison above |
| R2-17 | `setLinearDamping`, `setAngularDamping` | `linearDamping`, `angularDamping` | DONE: `kernel-features.test.js` "body setters, setType, projectPoint, ..." |
| R2-18 | `setDominanceGroup` (-127 to 127) | `dominance` | DONE: `kernel-features.test.js` "a body of higher dominance is not pushed by a lighter one" |
| R2-19 | `setAdditionalSolverIterations` | `body.additionalSolverIterations` | DONE: `passes2d.test.js` "extra solver passes read back, reject what is not a count, and survive a snapshot", "a column with extra passes reaches its resting squash, and the column that asked for none is the one it was"; `kernel/tests/passes.rs` |
| R2-20 | allow fast rotation (lifts the angular speed cap) | none to set: no default cap; `body.maxAngularSpeed` caps when asked | DONE by design: `kernel/tests/ccd.rs` `a_bar_spinning_many_turns_a_step_is_stopped_by_a_thin_wall_and_gains_no_energy`, `a_bar_turning_just_under_a_whole_turn_a_step_is_caught_by_a_block_its_tip_crosses`; `mass2d.test.js` "a maximum angular speed caps a body's spin, and the default leaves it free" |
| R2-21 | body enabled flag (`setEnabled`) | `body.enabled` | DONE: `enabled2d.test.js` "a disabled body ends its contacts, is found by no query, and resumes with its velocity"; `kernel/tests/enabled.rs` |
| R2-22 | `World.removeCollider(c, wakeUp)`, removal wakes what it touched | `removeCollider`, `removeBody` | DONE: `kernel-features.test.js` "colliders and bodies can be removed, and what they touched wakes" |
| R2-23 | mass computed from colliders by density, `recomputeMassPropertiesFromColliders` | density and `mass` on colliders, automatic | DONE: `shapes-more.test.js` "a compound collider is one collider of several parts with one mass" |

## Colliders page

| Row | Rapier 2D | Margo 2D | Status |
| --- | --- | --- | --- |
| C2-01 | `ball`, `cuboid`, `capsule` | `circle`, `box`, `capsule` | DONE: `physics2d.test.js` "a falling box lands on a tile floor at the expected pixel", `shapes-more.test.js` "a triangle is a solid collider and a rounded box has round corners"; circle and capsule: `kernel/tests/shapes.rs` |
| C2-02 | `convexHull(points)`, `convexPolyline(points)` | `polygon` (convex, and concave ones are split) | DONE: `physics2d.test.js` "concave polygons keep their notch" |
| C2-03 | `trimesh(vertices, indices, flags)` with `FIX_INTERNAL_EDGES` | `trimesh` | PARTIAL: `trimesh` DONE: `shapes-more.test.js` "a trimesh takes triangles by index and refuses bad ones"; the flags GAP |
| C2-04 | `polyline(vertices, indices)` | `polyline` (`oneSided`), `segment` | DONE: `shapes-more.test.js` "a one-sided polyline is a platform: up through it, then standing on it" |
| C2-05 | `heightfield(heights, scale)` | `heightfield` | DONE: `shapes-more.test.js` "a heightfield is smooth terrain a ball rolls down" |
| C2-06 | `roundCuboid`, `RoundConvexPolygon` with `borderRadius` | `borderRadius` on `box`, `polygon`, `triangle` | DONE: `shapes-more.test.js` "a triangle is a solid collider and a rounded box has round corners" |
| C2-07 | compound, voxels, half space (shapes the 2D build also has) | `compound`, `voxels`, `halfspace` | DONE: `shapes-more.test.js` "a compound collider is one collider of several parts with one mass", "voxels merge into outlines: a cup of cells holds a ball", "a halfspace holds a body and tilts with its normal" |
| C2-08 | `setTranslation`, `setRotation` on a collider's description, `setTranslationWrtParent`, `setRotationWrtParent` | `offset`, `rotation` options; `translation()`, `rotation()` reads | PARTIAL: creation DONE: `outline.test.js` "a sprite places the colliders on its pivot and scale, and its rect picks the frame of an atlas"; changing them after creation GAP |
| C2-09 | `setShape` after creation | none | GAP |
| C2-10 | `setDensity`, `setMass`, `setMassProperties` | `density` option and `setDensity`; `mass` option | PARTIAL: `setDensity` DONE: `outline.test.js` "collider settings reach every collider"; `setMass` and `setMassProperties` after creation GAP |
| C2-11 | `setFriction`, `setRestitution` | same | DONE: `outline.test.js` "collider settings reach every collider" |
| C2-12 | `setFrictionCombineRule`, `setRestitutionCombineRule` (`Average`, `Min`, `Multiply`, `Max`) | none | GAP |
| C2-13 | `setContactSkin` | none | GAP |
| C2-14 | `setSensor` | `sensor`, `setSensor` | DONE: `kernel-features.test.js` "a sensor reports entry and exit and pushes nothing; setSensor changes it later" |
| C2-15 | `setCollisionGroups`, `setSolverGroups` | same | DONE: `kernel-features.test.js` "collision groups let a body fall through a floor it does not meet", "solver groups that do not meet report the contact but push nothing" |
| C2-16 | `setActiveCollisionTypes` (`DEFAULT`, `KINEMATIC_FIXED`, ...) | `activeCollisionTypes` option, `setActiveCollisionTypes`, `activeCollisionTypes()` | DONE: `dynamics2d.test.js` "active collision types decide which pairs a collider meets, and read back" |
| C2-17 | `setActiveEvents(COLLISION_EVENTS, CONTACT_FORCE_EVENTS)` | `events`, `contactForceThreshold` options; `setActiveEvents`, `activeEvents()`, `setContactForceEventThreshold` | DONE: `dynamics2d.test.js` "active events and the contact force threshold change what a collider reports"; `kernel-features.test.js` "contact force events fire past the threshold and carry the force and normal" |
| C2-18 | `setActiveHooks(FILTER_CONTACT_PAIRS, FILTER_INTERSECTION_PAIR)` | `hooks: { filterPair, filterIntersection, modifyContact }` option, `collider.setActiveHooks` | DONE: contact filter: `kernel-features.test.js` "hooks: filterPair vetoes a pair, modifyContact makes a one-way platform and sets friction"; intersection filter and the setter (`collider.setActiveHooks`, `collider.activeHooks`): `hooks2d.test.js` "the intersection filter is asked of sensor pairs, the contact filter of solid pairs, and a veto stops the events", "a collider changes what it asks the hooks and reads it back; one that asks nothing is never asked"; `kernel/tests/hooks.rs` `a_sensor_pair_asks_the_intersection_filter_and_a_solid_pair_the_contact_filter`, `a_vetoed_intersection_reports_no_overlap` |
| C2-19 | collider enabled flag | `setEnabled`, `isEnabled` | DONE: `kernel-features.test.js` "a disabled collider meets nothing and is skipped by queries" |

## Joints and Joint constraints pages

| Row | Rapier 2D | Margo 2D | Status |
| --- | --- | --- | --- |
| J2-01 | `JointData.fixed`, `revolute`, `prismatic` (with `limits`) | `type: 'fixed' / 'revolute' / 'prismatic'` | DONE: `physics2d.test.js` "a revolute joint keeps its anchor distance and its motor spins", "a prismatic joint slides along its axis within limits" |
| J2-02 | generic joint, pin-slot | `generic`, `slot` | DONE: `shapes-more.test.js` "generic and slot joints hold only what they lock" |
| J2-03 | rope and spring joints | `rope`, `spring` | DONE: `physics2d.test.js` "a rope joint stops a falling body at its length; limits and removal work" |
| J2-04 | `configureMotorPosition`, `configureMotorVelocity`, `configureMotor` | `motor: { targetPosition, targetVelocity, stiffness, damping, maxForce }` | DONE: `physics2d.test.js` "a revolute joint keeps its anchor distance and its motor spins"; and for articulations `articulation.test.js` "joint limits hold and a position motor reaches its target" |
| J2-05 | `configureMotorModel` (acceleration or force) | none | GAP |
| J2-06 | `limitsEnabled`, revolute limits | `limits`, `setLimits`, `clearLimits` | DONE: `kernel-features.test.js` "joint limits and motors can be cleared" |
| J2-07 | contacts between jointed bodies on or off | `collide` | PARTIAL: the kernel holds it: `kernel/tests/joints.rs` `joined_bodies_do_not_collide_unless_asked`; the facade's `collide` option has no test of its own GAP |
| J2-08 | `createImpulseJoint(params, a, b, wakeUp)`, removal | `addJoint`, `removeJoint` | DONE: `physics2d.test.js` "a rope joint stops a falling body at its length; limits and removal work" |
| J2-09 | multibody joints: tree, exact, `createMultibodyJoint` | `addArticulation`, `multibody: true` | DONE: `articulation.test.js` "a long chain under a heavy end does not stretch, and the Jacobian matches finite motion", "a branched tree with a 1000:1 mass ratio across its branch stays closed" |
| J2-10 | loop closing: a multibody tree combined with impulse joints | an articulation plus `addJoint` between its links | DONE: `articulation.test.js` "an articulation closed by a joint between its last link and the ground holds a parallelogram linkage: coupler parallel, rocker with the crank" |
| J2-11 | multibody inverse kinematics | `inverseKinematics` | DONE: `articulation.test.js` "inverse kinematics puts the tip of a three-link arm on a target inside its reach" |

## Controllers page

| Row | Rapier 2D | Margo 2D | Status |
| --- | --- | --- | --- |
| K2-01 | `createCharacterController(offset)`, `computeColliderMovement`, `computedMovement`, `removeCharacterController` | `createCharacterController(body, { offset })`, `move`, `dispose` | DONE: `physics2d.test.js` "a character controller walks, stops at a wall and reports ground" |
| K2-02 | `setUp`, `setMaxSlopeClimbAngle`, `setMinSlopeSlideAngle` | `up`, `maxSlopeClimbAngle`, `minSlopeSlideAngle` | DONE: `dynamics2d.test.js` "a slope is climbed up to maxSlopeClimbAngle and not beyond it" (the audit found a slope past the limit was slid up like a ramp; fixed), "minSlopeSlideAngle decides whether a slope is slid along or climbed at the walker speed", "a character with another up walks the floor that is below it that way, grounded, and steps its ledges" |
| K2-03 | `enableAutostep(maxHeight, minWidth, includeDynamicBodies)`, `disableAutostep` | `autostep` | DONE: `dynamics2d.test.js` "autostep climbs a ledge that is no higher than its limit, and a taller one stops the character", "autostep needs minWidth of free room across the top of the ledge, and includeDynamic lets it step onto a dynamic body" |
| K2-04 | `enableSnapToGround(distance)`, `disableSnapToGround` | `snapToGround` | DONE: `dynamics2d.test.js` "snap to ground keeps the character on a floor that drops away by less than its distance" |
| K2-05 | slide on or off, `computedGrounded` | `slide`, `grounded` | DONE: `physics2d.test.js` "a character controller walks, stops at a wall and reports ground" |
| K2-06 | `numComputedCollisions`, `computedCollision(i)` | `collisions`, `hits` | DONE: `kernel-features.test.js` "body setters, setType, projectPoint, intersectionsWithBox, contactPairs and the character's hits" |
| K2-07 | `setApplyImpulsesToDynamicBodies`, character mass | `pushDynamic`, `mass` | DONE: `dynamics2d.test.js` "a character pushes a dynamic crate when it is asked to, and is stopped by it when not" |
| K2-08 | `filterFlags`, `filterGroups`, `filterPredicate` on `computeColliderMovement` | `createCharacterController(body, { filter })`, `controller.move(delta, filter)` | DONE: `dynamics2d.test.js` "a filter on the controller, or on one move, leaves colliders out of what the character meets" |
| K2-09 | `DynamicRayCastVehicleController` (the guide shows no 2D-specific note) | none | GAP: check against the rapier2d build before building; 3D has it (`rapier-parity.md` V-01 to V-04) |
| K2-10 | `createPidController`, `PidAxesMask`, `applyLinearCorrection` | `PidController2D` | DONE: `kernel-features.test.js` "a PID controller steers a body to a point and an angle" |

## Scene queries page

| Row | Rapier 2D | Margo 2D | Status |
| --- | --- | --- | --- |
| Q2-01 | `castRay`, `castRayAndGetNormal` (`maxToi`, `solid`) | `raycast` (`maxDistance`, `solid`) with the normal | DONE: `physics2d.test.js` "queries: raycast, point and shape overlaps, shape cast, filters" |
| Q2-02 | `intersectionsWithRay` (every hit, by callback) | none | GAP |
| Q2-03 | `castShape` with `targetDistance`, `stopAtPenetration`, `witness1`, `witness2`, `normal1`, `normal2` | `castShape(..., { targetDistance, stopAtPenetration })` giving `distance`, `point`, `normal`, `witnessA`, `witnessB`, `normalA`, `normalB`, `gap`, `status` (world space; Rapier's are in each shape's frame) | DONE: `queries2d.test.js` "a shape cast stops targetDistance short, gives the closest points of both shapes and says how it ended", "a cast that does not stop at penetration ignores a collider it overlaps and is leaving", and against Rapier 2D "shape cast and point projection agree with Rapier 2D: target distance, stop at penetration and a hollow projection"; `kernel/tests/queries.rs` |
| Q2-04 | `projectPoint(point, solid)` | `projectPoint(point, filter, solid)` | DONE: `queries2d.test.js` "projectPoint with solid off puts a point inside a collider on its nearest surface point" and against Rapier 2D (same test as Q2-03); `kernel/tests/queries.rs`, `kernel/tests/voxels.rs` |
| Q2-05 | `intersectionsWithPoint` | `overlapPoint` | DONE: `physics2d.test.js` "queries: raycast, point and shape overlaps, shape cast, filters" |
| Q2-06 | `intersectionsWithShape` | `overlapShape` | DONE: same test |
| Q2-07 | `collidersWithAabbIntersectingAabb` | `intersectionsWithBox` | DONE: `kernel-features.test.js` "body setters, setType, projectPoint, intersectionsWithBox, ..." |
| Q2-08 | filters: `QueryFilterFlags` (`EXCLUDE_DYNAMIC` and the rest), groups, `filterExcludeCollider`, `filterExcludeRigidBody`, predicate | `excludeFixed`, `excludeKinematic`, `excludeDynamic`, `excludeSensors`, `groups`, `exclude` (a body), `predicate` | PARTIAL: DONE: `physics2d.test.js` "collision groups filter queries"; excluding a single collider GAP |

## Advanced collision-detection page

| Row | Rapier 2D | Margo 2D | Status |
| --- | --- | --- | --- |
| E2-01 | `EventQueue`, `drainCollisionEvents(handle1, handle2, started)` | `on('contactstart' / 'contactend' / 'intersectionstart' / 'intersectionend')` | DONE: `physics2d.test.js` "events: contact on landing, intersection with a sensor" |
| E2-02 | `drainContactForceEvents`, `setContactForceEventThreshold` | `on('contactforce')`, `contactForceThreshold` | DONE: `kernel-features.test.js` "contact force events fire past the threshold and carry the force and normal" |
| E2-03 | `contactPairsWith(collider, cb)`, `contactPair(c1, c2, cb)` with manifold, flipped, solver contacts | `contactPairs(collider)` (points, normal, impulse, `solverActive`) | PARTIAL: `contactPairs` DONE: `kernel-features.test.js` "body setters, ..., contactPairs and the character's hits"; the two-collider `contactPair` GAP |
| E2-04 | `intersectionPairsWith(collider, cb)`, `intersectionPair(c1, c2)` | `physics.intersectionPair(a, b)`, `physics.intersectionPairsWith(collider)` | DONE: `pairs2d.test.js` "intersectionPair and intersectionPairsWith report what a sensor senses", and against Rapier 2D "the pair queries agree with Rapier 2D on the same scene" |
| E2-05 | `PhysicsHooks.filterContactPair` (skip, or `SolverFlags.COMPUTE_IMPULSES`) | `hooks.filterPair`, `hooks.modifyContact` (`solverActive`) | DONE: `kernel-features.test.js` "hooks: filterPair vetoes a pair, modifyContact makes a one-way platform and sets friction" |
| E2-06 | `PhysicsHooks.filterIntersectionPair` | `hooks.filterIntersection` (collider option, `setActiveHooks`) | DONE: `hooks2d.test.js`; `kernel/tests/hooks.rs` |
| E2-07 | CCD (body flag, `softCcdPrediction`, `maxCcdSubsteps`) | see R2-06 to R2-08 | DONE: R2-06 to R2-08 |

## Debug-renderer, Serialization and Determinism pages

| Row | Rapier 2D | Margo 2D | Status |
| --- | --- | --- | --- |
| D2-01 | `debugRender()` giving `vertices` and `colors`, two floats a vertex, four a colour | `debugRender({ shapes, joints, contacts, boxes })` giving `vertices` and `colors` | DONE: `kernel-features.test.js` "debugRender gives lines with colour codes; additionalMass adds to the mass" |
| D2-02 | `takeSnapshot`, `restoreSnapshot` | `snapshot()`, `restore()` | DONE: `kernel-features.test.js` "a snapshot restores the world and it steps exactly as the original did" |
| D2-03 | cross-platform determinism, same snapshot hash after the same steps | bit for bit | DONE: `physics2d.test.js` "600 steps with joints, contacts and a map are bit-for-bit repeatable"; browsers: `scripts/physics2d-kernel-browsers.mjs` |
| D2-04 | integration parameters in 2D (dt, `lengthUnit`, solver iterations, contact softness, warm start, slop, prediction distance, max corrective velocity, `maxCcdSubsteps`, timing counters) | `fixedTimestep`, `pixelsPerMeter` | PARTIAL: `physics2d.test.js` "pixelsPerMeter changes the unit, not the behaviour"; timing counters: `physics.timing` and `physics.counts`, `counts-timing.test.js` "timings are finite, not negative, each inside the step, and a reading leaves the world untouched"; `Physics2D.setSolver` and `physics.solver`: `substeps`, `iterations`, `contactHertz`, `contactDamping`, `contactMaxPush`, `restitutionThreshold`, `sleepThreshold`, `sleepTime`, `canSleep`, `blockSolver`, `jointHertz`, `jointDamping`, `jointMaxPush`, `jointGeometricStiffness` (`packages/physics2d/tests/solver-settings.test.js`); the rest GAP: warm start coefficient, allowed penetration (slop), prediction distance, `maxCcdSubsteps` and a softness for contacts with fixed bodies are not settings of the 2D kernel yet (3D has them: P-15 to P-33) |

## Soft-bodies page (it covers 2D)

The page's 2D builders are `rope`, `grid`, `polygon`, `disk`, `trimesh`, `polyline` and `volumetric`; 2D cells are triangles and boundary elements are segments. `cloth`, `cloth_anisotropic`, `cloth_tube`, `cuboid`, `sphere` and dihedrals are 3D only. Every row is a GAP, built as the optional entry `@margoengine/physics2d/soft`.

| Row | Rapier 2D | Status |
| --- | --- | --- |
| S2-01 | particles with two degrees of freedom; edges, bend edges, cells (triangles), surface, wire, skin, `setSkin` | GAP |
| S2-02 | builders `rope`, `grid`, `polygon`, `disk`, `trimesh`, `polyline`, `volumetric`, a raw `SoftBodyDesc` from positions, `append`, `addEdges` | GAP |
| S2-03 | options: `setPinnedParticles`, `setSoftness(freq, damping)`, `setParticleMass`, `setMass`, `setMasses`, `setParticleRadius`, `setSurfaceCollider`, `setNoSurfaceCollider`, `setSelfContacts`, `setLinearDamping`, `setGravityScale`, `setDominanceGroup`, `setCanSleep`, `setTranslation`, `setOriented`, `setAdditionalPgsIterations`, `setAdditionalSolverIterations` | GAP |
| S2-04 | shape matching, `setVolumePreservation`, `setVolumeFactor`, `setTensionOnly` | GAP |
| S2-05 | cell models `Volume`, `Corotational`, `NeoHookean`; `SoftBodyMaterial` (Young's modulus, Poisson ratio, damping ratios, `uniform(freq, damping)`); `edgeSoftness`, `bendSoftness`, `volumeSoftness` | GAP |
| S2-06 | constraints solver (default) and `SoftBodySolver.Fem` with its linear tolerance, iteration and dense DOF settings | GAP |
| S2-07 | plasticity (`plasticYield`, `plasticCreep`, `plasticMax`, edge plasticity, `resetPlasticity`) | GAP |
| S2-08 | tearing and cutting (`tearStrain`, `tearForce`, `setEdgeTearResistance`, `tearEdge`, `tearCell`, `tearSoftBody`, `cutSoftBody`, pieces, `drainSoftBodyTearEvents`) | GAP |
| S2-09 | attachment: impulse joints to soft frames, rigid and sensor colliders on soft bodies, `attachParticle`, `detachParticle`, clusters | GAP |
| S2-10 | deformable colliders (`PolylineFlags.DEFORMABLE`), mesh bindings `skinned`, `direct`, `directByPosition`, `setSkinCollision` | GAP |
| S2-11 | particle access, forces, impulses, radial impulse, kinematic targets, removal | GAP |
| S2-12 | global soft-body settings (resweep strain, extra substeps, contact stiffening, recovery) | GAP |

## What beats Rapier already

Where Margo is more accurate than Rapier 2D, the measurement and how to reproduce it is a claim in `docs/whitepaper/claims.md`: branched trees of joints solved exactly (Baraff 1996 sparse elimination, `joint/tree.rs`) where Rapier's impulse joints are iterative, and the 20-row pyramid that drops less and sleeps sooner than Box2D v3's and Rapier 2D's (LIM-527). Any further measured win goes in the same file with its reproduction.
