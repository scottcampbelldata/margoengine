# Physics collision and query parity

What Margo's own 3D collision kernel (`packages/physics/kernel`, the root entry of `@margoengine/physics`) holds against
what Rapier 3D offers. The list of Rapier capabilities comes from Rapier's public user guide and JavaScript API
documentation (rapier.rs, "Colliders", "Scene queries", "Contact and intersection events", "Physics hooks", "Continuous
collision detection", "Geometric queries"); no source of Rapier, parry or any other engine was read. A row is **full**
only when a test proves it, **partial** when part of it is held, **missing** when none of it is. Partial counts as a gap.
The root entry runs on the own kernel; "root" below means an option the entry already had before the switch, which the
switch kept.

Where each row lives: K = kernel (Rust), N = `next` entry (TS). Tests are in `packages/physics/tests` (JS) and
`packages/physics/kernel/tests` (Rust).

## Checked against the published API reference

Every row in this file was checked on 2026-11-24 against Rapier's published pages (the user guide pages and the JavaScript
API reference at rapier.rs/javascript3d: the `Collider`, `World`, `ColliderDesc`, `RayColliderHit`,
`RayColliderIntersection`, `ShapeCastHit`, `PointColliderProjection`, `TempContactForceEvent`, `TempContactManifold`,
`EventQueue` and `DebugRenderPipeline` classes and the `FeatureType`, `ActiveHooks`, `ActiveEvents`,
`ActiveCollisionTypes`, `TriMeshFlags`, `CoefficientCombineRule` and `QueryFilterFlags` enums), not against the package's
type declarations. What the check found and closed: `FIX_INTERNAL_EDGES_TWO_SIDED` (held from both sides, a test added),
`totalForceMagnitude` (added). Rapier's collider-level queries (`castRay`, `castRayAndGetNormal`, `intersectsRay`,
`projectPoint`, `intersectsShape`, `contactShape`, `contactCollider`, `castShape`, `castCollider`) are Margo's
`Physics.raycastCollider`, `projectPointOnCollider`, `colliderIntersectsShape`, `contactShape`, `contactPair`,
`castShapeAtCollider` and `castCollider`: the same queries under Physics-scoped names.

## Shapes

| Capability | Status | Notes | Tests |
| --- | --- | --- | --- |
| Ball | full | `ball`/`sphere` | `tests/next-physics.test.js`, `tests/next-contacts.test.js`, `kernel/tests/sat.rs` |
| Cuboid | full | `box` | `tests/next-contacts.test.js`, `tests/next-bodies.test.js` |
| Capsule | full | | `tests/next-contacts.test.js`, `tests/next-ccd.test.js`, `tests/next-collider-edit.test.js` |
| Cylinder, cone | full | with border radius (round cylinder, round cone) | `tests/next-revolved.test.js`, `kernel/tests/revolve.rs` |
| Convex hull, convex mesh (Quickhull from points) | full | | `tests/next-hull.test.js`, `kernel/tests/sat.rs` |
| Convex hull from indexed mesh (convex mesh with faces) | full | `convexHull` with `vertices` and `indices` | `tests/next-round.test.js` |
| Triangle mesh (trimesh) | full | every creation flag below | `tests/next-trimesh.test.js`, `tests/next-trimesh-flags.test.js`, `kernel/tests/mesh.rs` |
| Height field | full | Rapier's layout and split | `tests/next-heightfield.test.js`, `kernel/tests/mesh.rs` |
| Compound | full | convex parts | `tests/next-compound.test.js`, `kernel/tests/compound.rs` |
| Compound with non-convex parts (trimesh, height field, voxels, half space as part) | full | mesh, height field, voxel and half space parts (`next-compound-meshes.test.js`); a ball's rest height and rays match Rapier 0.21's own compound for height field and voxel parts; Rapier's JavaScript aborts (`RuntimeError: unreachable`) when a compound has a triangle mesh part, so that part is checked against the same parts as colliders of their own | `tests/next-compound-meshes.test.js` |
| Voxels | full | edit, combine, propagate | `tests/next-voxels.test.js`, `kernel/tests/voxel.rs` |
| Segment | full | a capsule with no radius; `next-segments.test.js` against Rapier | `tests/next-segments.test.js` |
| Triangle | full | a one-triangle mesh, both sides; ray and rest tested against Rapier | `tests/next-segments.test.js` |
| Polyline | full | a compound of segments; as a query shape see shape cast | `tests/next-segments.test.js`, `tests/next-query-shapes.test.js` |
| Half space | full | closed forms for queries, a laid box for contacts; not against meshes, height fields, voxels or another half space | `tests/next-halfspace.test.js`, `kernel/tests/halfspace.rs` |
| Round cuboid, round convex hull | full | `borderRadius` on box and hull colliders, compound parts and query shapes, tested against Rapier | `tests/next-round.test.js`, `kernel/tests/round_polyhedra.rs` |
| Round triangle | full | `triangle` with `borderRadius`; contacts through the skin, queries through the border | `tests/next-round.test.js` |
| Collider shape change after creation | full | `collider.setShape`; not for compounds | `tests/next-collider-edit.test.js` |
| Collider position and rotation relative to its body, set after creation | full | `setTranslationWrtParent`, `setRotationWrtParent` | `tests/next-collider-edit.test.js` |

## Trimesh flags

| Flag | Status | Tests |
| --- | --- | --- |
| FIX_INTERNAL_EDGES | full | `tests/next-trimesh.test.js`, `tests/next-heightfield.test.js` |
| MERGE_DUPLICATE_VERTICES | full | `tests/next-trimesh-flags.test.js` |
| DELETE_BAD_TOPOLOGY_TRIANGLES | full | `tests/next-trimesh-flags.test.js` |
| DELETE_DEGENERATE_TRIANGLES | full | `tests/next-trimesh-flags.test.js` |
| DELETE_DUPLICATE_TRIANGLES | full | `tests/next-trimesh-flags.test.js` |
| ORIENTED (inside/outside known, solid point queries) | full | `tests/next-trimesh-flags.test.js` |

## Broad phase, narrow phase, contacts

| Capability | Status | Notes | Tests |
| --- | --- | --- | --- |
| Broad phase on moving and fixed colliders | full | | `tests/kernel-broad.test.js`, `kernel/tests/broad.rs` |
| Narrow phase for every pair of held shapes, manifolds up to 4 points | full | | `tests/kernel-contacts.test.js`, `tests/next-contacts.test.js`, `kernel/tests/sat.rs`, `kernel/tests/gjk.rs` |
| Narrow phase for segment, triangle, polyline and half space against every shape | full | a mesh meets no mesh, as on Rapier; a half space meets no mesh or half space | `tests/next-segments.test.js`, `tests/next-halfspace.test.js`, `tests/next-compound-meshes.test.js` |
| Contact skin as a collider option | full | `contactSkin`; contact limit includes the step's motion and the skins | `tests/next-skin.test.js` |
| Prediction distance as a world parameter | full | `predictionDistance`, default 0.04 m, tested inside and beyond it (`next-prediction.test.js`) | `tests/next-prediction.test.js` |
| Contact manifold read (`contacts()`, `contactPoints`, `touching`, `contactPair`) | full | `contactPair` works for any two colliders | `tests/next-pair-queries.test.js`, `tests/next-collider-api.test.js` |
| Friction, restitution, combine rules | full | all four rules | `tests/next-contacts.test.js`, `tests/next-collider-api.test.js` |
| Collision groups, solver groups | full | | `tests/next-events.test.js` |
| Active collision types (which of dynamic, kinematic, fixed pairs collide) | full | all six kinds, both colliders must want it; `kernel/tests/collision_types.rs`, `next-collision-types.test.js` | `tests/next-collision-types.test.js`, `kernel/tests/collision_types.rs` |
| Sensors, intersection events | full | | `tests/next-events.test.js` |
| Contact events, intersection events (start, end) | full | | `tests/next-events.test.js`, `tests/next-collision-types.test.js` |
| Active events per collider split into collision and contact-force flags | full | `setActiveEvents`; contact force defaults on, Rapier's is off | `tests/next-collision-types.test.js`, `tests/next-events.test.js` |
| Contact-force events with a threshold | full | per-collider threshold, the larger of the pair's two | `tests/next-collision-types.test.js`, `tests/next-collider-api.test.js` |

## Continuous collision

| Capability | Status | Notes | Tests |
| --- | --- | --- | --- |
| CCD for a body | full | | `tests/next-ccd.test.js`, `kernel/tests/ccd.rs` |
| Soft CCD (`softCcdPrediction`) | full | the contact limit always includes the step's motion; the option adds to it | `tests/next-skin.test.js` |

## Hooks

| Capability | Status | Notes | Tests |
| --- | --- | --- | --- |
| Pair filtering (contact pairs and intersection pairs) | full | `contactFilter` | `tests/next-events.test.js`, `tests/next-collider-api.test.js` |
| Contact modification: friction, restitution, normals, remove contact | full | `contactModifier`, `modifyContacts` | `tests/next-contact-modifier.test.js` |
| Contact modification: tangent (surface) velocity, a conveyor | full | `contact.surfaceVelocity` | `tests/next-contact-modifier.test.js` |
| One-way platforms (allowed contact normal) | full | `contact.oneWay` | `tests/next-contact-modifier.test.js` |

## Scene queries

| Capability | Status | Notes | Tests |
| --- | --- | --- | --- |
| Ray cast, all hits, solid flag, max time of impact | full | | `tests/next-queries.test.js`, `kernel/tests/query.rs` |
| Shape cast, all hits, target distance, stop at penetration | full | every convex query shape (ball, box, capsule, cylinder, cone, segment, triangle, hull, round box and hull), tested against Rapier's casts ; a compound, mesh, height field or voxel grid is cast piece by piece, and a half space by its plane, tested against Rapier | `tests/next-shape-queries.test.js`, `tests/next-query-shapes.test.js`, `kernel/tests/cast.rs`, `kernel/tests/cast_parallel.rs` |
| Point projection, all hits | full | a trimesh holds no point | `tests/next-shape-queries.test.js`, `kernel/tests/cast.rs` |
| Point containment (`intersectPoint`) | full | | `tests/next-shape-queries.test.js`, `tests/next-trimesh-flags.test.js` |
| Shape intersection (`intersectShape`) | full | the same query shapes | `tests/next-shape-queries.test.js`, `tests/next-query-shapes.test.js` |
| AABB intersection (colliders whose box meets a box) | full | `intersectAabb`, `collider.aabb()` | `tests/next-pair-queries.test.js` |
| Collider-to-collider distance and closest points | full | `colliderDistance`; convex, compound, mesh, half space | `tests/next-pair-queries.test.js` |
| Collider-to-collider contact (`contactPair`) and intersection tests | full | `contactPair`, `intersectionPair`, any two colliders; a mesh gives each triangle's own normal | `tests/next-pair-queries.test.js` |
| Filter flags, groups, predicate, exclude collider and body | full | | `tests/next-queries.test.js`, `tests/next-shape-queries.test.js` |
| Ray cast, point projection, containment, shape cast and overlap against a single collider | full | `raycastCollider` and the rest | `tests/next-collider-queries.test.js` |
| Query pipeline updated on demand (`updateQueryPipeline`) | full | there is no pipeline: queries read the poses as they are, tested after `setPosition` | `tests/next-collider-queries.test.js` |

## Collider and narrow-phase API (Rapier's Colliders and Geometric queries sections)

| Capability | Status | Notes | Tests |
| --- | --- | --- | --- |
| Volume, mass, density readers; set the mass from the volume | full | `volume()`, `mass()`, `setMass()` | `tests/next-collider-api.test.js` |
| Collider-level mass properties (mass, centre, principal inertia and its frame) | full | `massProperties`, `setMassProperties`, `clearMassProperties` | `tests/next-collider-api.test.js` |
| Friction and restitution combine rules, read and set per collider | full | `frictionCombineRule`, `setFrictionCombineRule` and the restitution pair | `tests/next-collider-api.test.js` |
| Round radius, read and set | full | `borderRadius()`, `setBorderRadius()` | `tests/next-collider-api.test.js` |
| World pose of a collider, shape type | full | `translation()`, `rotation()`, `shape` | `tests/next-collider-api.test.js` |
| Vertices, indices, height field heights, rows, columns and scale | full | `vertices()`, `indices()`, `heightfield*()`; heights read as scaled, scale `[width, 1, depth]` | `tests/next-collider-api.test.js` |
| Active hooks per collider (filter contact pairs, filter intersection pairs, modify contacts) | full | `activeHooks`, `setActiveHooks`, `intersectionFilter` | `tests/next-collider-api.test.js` |
| Contact pairs and intersection pairs of a collider | full | `contactPairsWith`, `intersectionPairsWith` | `tests/next-collider-api.test.js` |
| Contact of a collider with a shape | full | `contactShape` | `tests/next-collider-api.test.js` |
| Cast of a collider onto another, or onto the world | full | `castColliderOnto`, `castCollider` | `tests/next-collider-api.test.js` |
| Feature type and id on ray hits and point projections | full | `featureType`, `featureId`: Margo's numbering, boxes, hulls, meshes and height fields; other shapes are unknown | `tests/next-collider-api.test.js` |
| Contact detail: friction, restitution, per-point normal and tangent impulses | full | `contactPair` | `tests/next-collider-api.test.js` |
| Contact force event totals: total force, maximum force and its direction | full | `totalForce`, `maxForceMagnitude`, `maxForceDirection`; the solver's last substep scaled to the step | `tests/next-collider-api.test.js` |
| Triangle mesh fix of internal edges from both sides (`FIX_INTERNAL_EDGES` and `FIX_INTERNAL_EDGES_TWO_SIDED`) | full | `fixInternalEdges` holds from the front and from the back of the surface | `tests/next-trimesh.test.js` |
| Contact force event totals: the length of the total force | full | `totalForceMagnitude` next to `totalForce` | `tests/next-collider-api.test.js` |
| Iterate every collider | full | `getColliders()` | `tests/next-collider-api.test.js` |
| Pair filter answers: skip the pair, solve it, or find its contacts and fire its events with no forces (a hook answering with no solver flags) | full | `contactFilter` returns `false`, `true` or `'noForces'`; Rapier's hook agrees on the same scene | `tests/next-pair-no-forces.test.js` |
| Query filter with no groups applies no group test | full | `groups` left out means every collider is seen, even one whose filter is 0 | `tests/next-query-no-groups.test.js`, `kernel/tests/query.rs` |
| Debug render filtered by query flags, groups and a predicate | full | `debugRender({filter})`: colliders, their contacts and the joints between shown bodies | `tests/next-debug-filter.test.js` |

## Soft bodies (Rapier's Soft-bodies guide page)

The first slice is built in `@margoengine/physics/soft`: particles held by compliant distance constraints (XPBD), ropes and cloth, pinning, kinematic targets, forces, edge tearing, and two-way contact with spheres, boxes and capsules. The rest is in progress as separate pieces of work; the deformable-collider row needs this kernel's mesh refit and contacts against vertices that move each step. Rows marked partial name what is still missing.

| Capability | Status | Notes | Tests |
| --- | --- | --- | --- |
| Builders: rope, cloth (and anisotropic, tube), grid, cuboid, polygon, disk, sphere, trimesh, polyline, volumetric | partial | `SoftBodyDesc.rope`, `cloth`, `clothTube`, `trimesh`, `sphere` (a closed surface that holds its volume, with bend edges) and `new SoftBodyDesc(positions)` are built; `SoftBodyDesc.box` and `solid` (a ball, a ring or any solid carved from a grid) are the volumetric builders, cuboid and sphere among them; anisotropic cloth is missing; grid, polygon, disk and polyline are Rapier's 2D builders and belong to `@margoengine/physics2d` | `tests/soft.test.js` |
| Lattice elements: edges, bend edges, dihedrals, cells, surface, wire, skin; merging builders | partial | `setEdges`, `setBendEdges`, `addEdges`, `append`, and tetrahedral cells (`setCells`, `SoftBodyDesc.box`, `SoftBodyDesc.solid`) are built; dihedrals, surface, wire and skin are missing | `tests/soft.test.js`, `tests/soft-cells.test.js` |
| Builder settings: pinned particles, softness, masses, particle radius, surface collider, self contacts, damping, gravity scale, dominance, sleep | partial | pinned particles, softness, masses, particle radius, edge tear resistance, damping, gravity scale and translation are built; surface collider (`soft.createSurfaceCollider`) and self contacts (`setSelfContacts`, cloth on cloth with friction) are built; dominance and sleep are missing | `tests/soft.test.js` |
| Materials and plasticity: shape matching, bend, edge and volume softness, Young modulus, Poisson ratio, damping, plastic yield, creep and flow | full | `SoftBodyMaterial` has edge, bend and shape matching softness and `tearStrain`, and shape matching is built (`setShapeMatching`, default on for `trimesh`); `CellMaterial` has `youngsModulus`, `poissonRatio`, `model`, `density`, `yieldStrain`, `creep` and `tearStrain`, and `soft.cellDamping` the damping; plastic flow is the multiplicative split of Bargteil et al. (2007) | `tests/soft.test.js`, `tests/soft-cells.test.js` |
| Tearing and cutting: edge and cell tears, tear events, splitting into pieces | partial | edge tears by strain or `tearEdge`, cell tears by strain (`tearStrain`) or `tearCell`, and `onTear` events (edges and cells) are built; a torn element stays in the body (particles are not duplicated, pieces do not become new bodies); cuts are missing | `tests/soft.test.js`, `tests/soft-cells.test.js` |
| Solvers and cell models: constraints solver, finite elements, volume, corotational and neo-Hookean cells; recovery settings | partial | the XPBD solver with `soft.substeps` and `soft.iterations`; `CellMaterial.model` is `'neo-hookean'` (stable Neo-Hookean, Smith, de Goes and Kim 2018, as constraints after Macklin and Müller 2021, which also recovers an inverted cell) or `'corotated'` (Müller and Gross 2004); a cantilever matches Euler-Bernoulli as the mesh is refined and a near-incompressible rubber keeps its volume; there are no recovery settings to tune, an inverted cell comes back by itself | `tests/soft-cells.test.js`, `packages/physics/soft-kernel/tests/fem.rs` |
| Clusters and root frames: frame bodies, stiffness scales, pinning, kinematic targets, spring joints | partial | `desc.setClusters(groups, hertz)` is built: groups of particles held by shape matching (Müller et al. 2005) as implicit springs, overlapping allowed; frame bodies, per-cluster stiffness scales and spring joints are missing | `tests/soft-cells.test.js`, `packages/physics/soft-kernel/tests/fem.rs` |
| Particle API: positions, velocities, pin, kinematic target, attach and detach, forces and impulses (radial too) | partial | everything is built (`attachParticle` and `detachParticle` pin a particle to a rigid body at its place now, tested hanging a crate and dragging one); `applyImpulse` is the whole body's impulse shared by mass, which has not been compared with Rapier's | `tests/soft.test.js` |
| Deformable trimesh collider: vertices that move each step, the tree refit with no rebuild, queries and contacts against the moved surface | full | `deformable: true`, `collider.setVertices(positions, {velocities, now})`: aimed like a kinematic body, per-vertex surface velocity for friction, bounce and swept contacts, landed with one refit at the step's end | `tests/next-deformable.test.js`, `kernel/tests/refit.rs` |
| Particle contacts for every collider shape: a swept ball of radius r, up to 4 planes a particle with depth or open gap, surface velocity (rigid and deformable) and time of impact, batched, honouring per-particle groups and filters, never sensors | full | `Physics.softContacts`, `KernelWorld.softContacts`, `probeParticles` | `tests/soft-probe.test.js` |
| Cloth self-collision and soft-soft collision: vertex against triangle and edge against edge, found before they pass through, grouped by shared vertices, pushed apart as position constraints | full | `cloth::find_contacts` (kernel-common) and `soft-kernel/src/collide.rs` | `kernel/tests/cloth.rs`, `soft-kernel/tests/collide.rs` |
| Skinning and mesh bindings: skinned and direct bindings of a deformable collider to a soft body's mesh | partial | `soft.createSurfaceCollider(body)` binds a deformable trimesh collider directly to the particles of a mesh body and drives `setVertices` with vertex velocities each step; skinned bindings (a detailed mesh embedded in cells) and `directByPosition` are missing | `tests/soft.test.js` |

This table is updated as each gap lands; the end state is every row full. A test named `next-x` is `packages/physics/tests/next-x.test.js`, one named `kernel/tests/x.rs` is in `packages/physics/kernel/tests`.
