# Physics collision and query parity

What Margo's own 3D collision kernel (`packages/physics/kernel`, shipped as `@margoengine/physics/next`) holds against
what Rapier 3D offers. The list of Rapier capabilities comes from Rapier's public user guide and JavaScript API
documentation (rapier.rs, "Colliders", "Scene queries", "Contact and intersection events", "Physics hooks", "Continuous
collision detection", "Geometric queries"); no source of Rapier, parry or any other engine was read. A row is **full**
only when a test proves it, **partial** when part of it is held, **missing** when none of it is. Partial counts as a gap.
The root entry (`@margoengine/physics`) still runs on Rapier, so "root" below means that entry's current option, which the
switch must keep.

Where each row lives: K = kernel (Rust), N = `next` entry (TS). Tests are in `packages/physics/tests` (JS) and
`packages/physics/kernel/tests` (Rust).

## Shapes

| Capability | Status | Notes |
| --- | --- | --- |
| Ball | full | `ball`/`sphere` |
| Cuboid | full | `box` |
| Capsule | full | |
| Cylinder, cone | full | with border radius (round cylinder, round cone) |
| Convex hull, convex mesh (Quickhull from points) | full | |
| Convex hull from indexed mesh (convex mesh with faces) | full | `convexHull` with `vertices` and `indices` |
| Triangle mesh (trimesh) | full | every creation flag below |
| Height field | full | Rapier's layout and split |
| Compound | full | convex parts |
| Compound with non-convex parts (trimesh, height field, voxels, half space as part) | missing | Rapier's compound takes any shape |
| Voxels | full | edit, combine, propagate |
| Segment | full | a capsule with no radius; `next-segments.test.js` against Rapier |
| Triangle | full | a one-triangle mesh, both sides; ray and rest tested against Rapier |
| Polyline | full | a compound of segments; as a query shape see shape cast |
| Half space | full | closed forms for queries, a laid box for contacts; not against meshes, height fields, voxels or another half space |
| Round cuboid, round convex hull | full | `borderRadius` on box and hull colliders, compound parts and query shapes, tested against Rapier |
| Round triangle | full | `triangle` with `borderRadius`; contacts through the skin, queries through the border |
| Collider shape change after creation | full | `collider.setShape`; not for compounds |
| Collider position and rotation relative to its body, set after creation | full | `setTranslationWrtParent`, `setRotationWrtParent` |

## Trimesh flags

| Flag | Status |
| --- | --- |
| FIX_INTERNAL_EDGES | full |
| MERGE_DUPLICATE_VERTICES | full |
| DELETE_BAD_TOPOLOGY_TRIANGLES | full |
| DELETE_DEGENERATE_TRIANGLES | full |
| DELETE_DUPLICATE_TRIANGLES | full |
| ORIENTED (inside/outside known, solid point queries) | full |

## Broad phase, narrow phase, contacts

| Capability | Status | Notes |
| --- | --- | --- |
| Broad phase on moving and fixed colliders | full | |
| Narrow phase for every pair of held shapes, manifolds up to 4 points | full | |
| Narrow phase for segment, triangle, polyline and half space against every shape | full | a mesh meets no mesh, as on Rapier; a half space meets no mesh or half space |
| Contact skin / prediction distance as a collider option | full | `contactSkin`; contact limit includes the step's motion and the skins |
| Contact manifold read (`contacts()`, `contactPoints`, `touching`, `contactPair`) | full | `contactPair` works for any two colliders |
| Friction, restitution, combine rules | full | all four rules |
| Collision groups, solver groups | full | |
| Active collision types (which of dynamic, kinematic, fixed pairs collide) | full | all six kinds, both colliders must want it; `kernel/tests/collision_types.rs`, `next-collision-types.test.js` |
| Sensors, intersection events | full | |
| Contact events, intersection events (start, end) | full | |
| Active events per collider split into collision and contact-force flags | full | `setActiveEvents`; contact force defaults on, Rapier's is off |
| Contact-force events with a threshold | full | per-collider threshold, the larger of the pair's two |

## Continuous collision

| Capability | Status | Notes |
| --- | --- | --- |
| CCD for a body | full | |
| Soft CCD (`softCcdPrediction`) | full | the contact limit always includes the step's motion; the option adds to it |

## Hooks

| Capability | Status | Notes |
| --- | --- | --- |
| Pair filtering (contact pairs and intersection pairs) | full | `contactFilter` |
| Contact modification: friction, restitution, normals, remove contact | full | `contactModifier`, `modifyContacts` |
| Contact modification: tangent (surface) velocity, a conveyor | full | `contact.surfaceVelocity` |
| One-way platforms (allowed contact normal) | full | `contact.oneWay` |

## Scene queries

| Capability | Status | Notes |
| --- | --- | --- |
| Ray cast, all hits, solid flag, max time of impact | full | |
| Shape cast, all hits, target distance, stop at penetration | partial | every convex query shape (ball, box, capsule, cylinder, cone, segment, triangle, hull, round box and hull), tested against Rapier's casts; a non-convex query shape (mesh, height field, compound, half space) is open |
| Point projection, all hits | full | a trimesh holds no point |
| Point containment (`intersectPoint`) | full | |
| Shape intersection (`intersectShape`) | partial | the same convex query shapes; non-convex ones open |
| AABB intersection (colliders whose box meets a box) | full | `intersectAabb`, `collider.aabb()` |
| Collider-to-collider distance and closest points | full | `colliderDistance`; convex, compound, mesh, half space |
| Collider-to-collider contact (`contactPair`) and intersection tests | full | `contactPair`, `intersectionPair`, any two colliders; a mesh gives each triangle's own normal |
| Filter flags, groups, predicate, exclude collider and body | full | |
| Ray cast, point projection, containment, shape cast and overlap against a single collider | full | `raycastCollider` and the rest |
| Query pipeline updated on demand (`updateQueryPipeline`) | full | there is no pipeline: queries read the poses as they are, tested after `setPosition` |

This table is updated as each gap lands; the end state is every row full.
