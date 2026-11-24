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
| Convex hull from indexed mesh (convex mesh with faces) | partial | `addHull` takes faces; no `next` option for indexed input |
| Triangle mesh (trimesh) | partial | `fixInternalEdges` only; the other creation flags below are missing |
| Height field | full | Rapier's layout and split |
| Compound | full | convex parts |
| Compound with non-convex parts (trimesh, height field, voxels, half space as part) | missing | Rapier's compound takes any shape |
| Voxels | full | edit, combine, propagate |
| Segment | full | a capsule with no radius; `next-segments.test.js` against Rapier |
| Triangle | full | a one-triangle mesh, both sides; ray and rest tested against Rapier |
| Polyline | full | a compound of segments; as a query shape see shape cast |
| Half space | full | closed forms for queries, a laid box for contacts; not against meshes, height fields, voxels or another half space |
| Round cuboid, round convex hull | partial | `borderRadius` on box and hull colliders, tested against Rapier; not on compound parts or query shapes |
| Round triangle | missing | |
| Collider shape change after creation | missing | |
| Collider position and rotation relative to its body, set after creation | partial | read only |

## Trimesh flags

| Flag | Status |
| --- | --- |
| FIX_INTERNAL_EDGES | full |
| MERGE_DUPLICATE_VERTICES | missing |
| DELETE_BAD_TOPOLOGY_TRIANGLES | missing |
| DELETE_DEGENERATE_TRIANGLES | missing |
| DELETE_DUPLICATE_TRIANGLES | missing |
| ORIENTED (inside/outside known, solid point queries) | missing |

## Broad phase, narrow phase, contacts

| Capability | Status | Notes |
| --- | --- | --- |
| Broad phase on moving and fixed colliders | full | |
| Narrow phase for every pair of held shapes, manifolds up to 4 points | full | |
| Narrow phase for the missing shapes (segment, triangle, polyline, half space) against every shape | missing | |
| Contact skin / prediction distance as a collider option | missing | the step uses a fixed prediction |
| Contact manifold read (`contacts()`, `contactPoints`, `touching`) | partial | no per-pair `contactPair(a, b)` with normal and depth per point for any two colliders (touching pairs only) |
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
| Soft CCD (`softCcdPrediction`) | missing | |

## Hooks

| Capability | Status | Notes |
| --- | --- | --- |
| Pair filtering (contact pairs and intersection pairs) | full | `contactFilter` |
| Contact modification: friction, restitution, tangent velocity, normals, remove contact | missing | |
| One-way platforms (allowed contact normal) | missing | |

## Scene queries

| Capability | Status | Notes |
| --- | --- | --- |
| Ray cast, all hits, solid flag, max time of impact | full | |
| Shape cast, all hits, target distance, stop at penetration | partial | query shape is ball, box, capsule or hull only; Rapier casts any shape, with a cast rotation and a rotating motion off |
| Point projection, all hits | full | a trimesh holds no point |
| Point containment (`intersectPoint`) | full | |
| Shape intersection (`intersectShape`) | partial | query shape limit as shape cast |
| AABB intersection (colliders whose box meets a box) | missing | |
| Collider-to-collider distance and closest points | missing | |
| Collider-to-collider contact (`contactPair`) and intersection tests | partial | |
| Filter flags, groups, predicate, exclude collider and body | full | |
| Ray cast on a ray against a single collider, shape cast of one collider | missing | |
| Query pipeline updated on demand (`updateQueryPipeline`) | partial | queries read the last step's poses |

This table is updated as each gap lands; the end state is every row full.
