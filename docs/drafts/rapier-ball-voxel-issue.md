# DRAFT (not posted; Scott decides): rapier issue

**Title:** `RuntimeError: unreachable` in `World.step` when a ball rolls off the edge of a Voxels collider (rapier3d-compat 0.21.0)

**Version:** `@dimforge/rapier3d-compat` 0.21.0 (the latest release, 2026-09-25), Node.js 24.15.0, Windows 11 x64.
Not tried in a browser.

## Minimal repro

```js
import RAPIER from '@dimforge/rapier3d-compat';

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

// A 32 x 1 x 8 floor of unit voxels: cells x 0..31, y 0, z 0..7 (top face at y = 1, edge at x = 32).
const cells = [];
for (let x = 0; x < 32; x++) for (let z = 0; z < 8; z++) cells.push(x, 0, z);
world.createCollider(RAPIER.ColliderDesc.voxels(new Int32Array(cells), { x: 1, y: 1, z: 1 }));

// A ball resting on the floor, rolling toward the edge.
const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(26, 1.4, 4.3).setLinvel(4, 0, 0));
world.createCollider(RAPIER.ColliderDesc.ball(0.4), body);

for (let i = 0; i < 300; i++) {
  try {
    world.step();
  } catch (error) {
    console.log(`step ${i}: ${error}`); // step 127: RuntimeError: unreachable
    break;
  }
}
```

## Expected

The ball rolls off the edge and falls.

## Actual

`world.step()` throws `RuntimeError: unreachable` (a Rust panic in the wasm build) at step 127, when the ball's centre
passes x = 32. After that the instance is unusable: the next call (even `body.translation()`) throws "recursive use of
an object detected which would lead to unsafe aliasing in rust".

## What we narrowed down

- Only the **Ball** shape: cuboid, capsule, cylinder, round cuboid and convex-hull bodies on the same floor are fine.
  Ball radii 0.1 to 2, rolling or sliding (rotations locked), with and without CCD all panic.
- A ball reaching a voxel edge it does not sit on top of panics: rolling off a ledge (the repro, also with the edge
  inside a larger grid domain or a hole cut with `setVoxel(.., false)`), rolling into a 1-voxel step or wall while on the
  floor, and crossing from one Voxels collider to an adjacent one, with or without `combineVoxelStates(other, 0, 0, 0)`
  in either direction. A ball rolling across cells inside one collider, resting, or falling straight down through a
  1-cell hole does not panic.
- Possibly the same root cause as #1029 (debug assertion in the incremental solver-contact graph when a ball rolls on
  Voxels; fix proposed in PR #1030: treat Voxels pairs as composite) and #1043 ("stale ContactRef manifold ordinal"
  panic with ball and voxel colliders, rapier2d 0.36.1). Also related: #993 (ball-voxel ghost collisions).
- Workaround we use: give chunks near ball bodies a `TriMesh` (with `FIX_INTERNAL_EDGES`) of the same faces and
  disable their Voxels collider while a ball is near. 96 seeded balls over ledges, walls, pits and collider borders ran
  400 steps each with no panic.

## Possibly separate (lower priority)

When a ball rolls from one collider onto an adjacent coplanar one (two `TriMesh` quads, or two cuboids), it can lose up
to one step of travel at the transition (no velocity change, no bump): about 0.1 m at 6 m/s on two quads. A single
quad or a single cuboid shows none.
