# @margoengine/physics

Import `margoengine/physics` from the `margoengine` package, or `@margoengine/physics` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Rigid-body physics for Margo Engine on [Rapier](https://rapier.rs): a fixed-step engine plugin with interpolation, colliders (compound and convex-decomposed ones included), joints (rope and spring included), ropes and chains, ray-cast vehicles, scene queries, collision events and a character controller.

Build from source with `npm run build` in `packages/physics`.

It exports `Physics` (the world: bodies, colliders, joints, queries and events), `PhysicsBody`, `PhysicsJoint`, `CharacterController`, `Vehicle` and `Rope`. The React components in `@margoengine/react/physics` are `<Physics>`, `<RigidBody>`, the collider components (`CuboidCollider`, `BallCollider` and others), `useJoint`, `usePhysics`, `useBeforePhysicsStep` and `useAfterPhysicsStep`. Rapier is not bundled: you install `@dimforge/rapier3d-compat` (Apache-2.0) yourself and pass the initialized module in.

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {Physics, collisionGroups} from 'margoengine/physics';

await Physics.load();
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const physics = new Physics(engine); // registers itself with engine.use()

const floor = engine.createMesh().setGeometry(box(20, 1, 20)).setPosition([0, -0.5, 0]);
physics.addBody(floor, {type: 'fixed'});                 // box collider fitted to the geometry

const crate = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color: '#c08040'})).setPosition([0, 5, 0]);
const body = physics.addBody(crate, {colliders: {shape: 'box', restitution: 0.3, density: 2}});
body.applyImpulse([0, 2, 0]);

// Hinge with limits and a motor.
const frameBody = physics.addBody(null, {type: 'fixed', position: [2, 1, 0], colliders: []});
const doorMesh = engine.createMesh().setGeometry(box(1, 2, 0.1)).setPosition([2.5, 1, 0]);
const door = physics.addBody(doorMesh, {colliders: {shape: 'box', halfExtents: [0.5, 1, 0.05]}});
physics.addJoint(frameBody, door, {type: 'revolute', anchorB: [-0.5, 0, 0], axis: [0, 1, 0], limits: [0, Math.PI / 2], motor: {targetVelocity: 1}});

// Queries return the core Mesh that was hit.
const hit = physics.raycast(engine.camera.position, [0, -1, 0]);
hit?.mesh; hit?.distance; hit?.point; hit?.normal;

// Events with the meshes involved.
physics.on('contactstart', ({meshA, meshB}) => {});
physics.on('intersectionstart', ({bodyA, bodyB}) => {}); // sensors

// Character controller on a kinematic capsule, driven once per fixed step.
const input = {x: 0, z: 1}; // from your keyboard or gamepad handling
const playerMesh = engine.createMesh().setGeometry(box(0.6, 1.6, 0.6)).setPosition([-2, 1, 0]);
const player = physics.addBody(playerMesh, {type: 'kinematicPosition', colliders: {shape: 'capsule', halfHeight: 0.5, radius: 0.3}});
const controller = physics.createCharacterController(player, {maxSlopeClimbAngle: Math.PI / 4, autostep: {maxHeight: 0.3, minWidth: 0.2}, snapToGround: 0.2});
physics.on('beforestep', dt => controller.move([input.x * 4 * dt, -9.81 * dt, input.z * 4 * dt]));

engine.start(); // each frame's delta drives the accumulator
// On teardown: physics.dispose(), engine.removePlugin('physics') or engine.dispose().
```

## Ropes, vehicles and compound shapes

```ts
import {Engine, box} from 'margoengine/core';
import {Physics, Rope, Vehicle} from 'margoengine/physics';

await Physics.load();
const engine = await Engine.create(document.querySelector('canvas')!);
const physics = new Physics(engine);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [50, 0.5, 50]}});

// A rope hung from a fixed hook, carrying a crate. rope.points() is the polyline for @margoengine/lines.
const crate = physics.addBody(null, {position: [0, 3, 0], colliders: {shape: 'box', halfExtents: [0.3, 0.3, 0.3]}});
const rope = new Rope(physics, {start: [0, 6, 0], end: [0, 3.3, 0], segments: 10, attachStart: 'fixed', attachEnd: crate});
const polyline = rope.points();

// Rope and spring joints between two bodies.
const hook = physics.addBody(null, {type: 'fixed', position: [3, 5, 0], colliders: []});
const bob = physics.addBody(null, {position: [3, 4, 0], colliders: {shape: 'sphere', radius: 0.2, mass: 2}});
physics.addJoint(hook, bob, {type: 'spring', restLength: 1, stiffness: 50, damping: 5}); // or {type: 'rope', length: 1.5}

// One collider from convex parts, and a concave mesh split into convex pieces for a dynamic body.
physics.addBody(null, {position: [-3, 2, 0], colliders: {shape: 'compound', parts: [
  {shape: 'sphere', radius: 0.4, offset: [-0.8, 0, 0]},
  {shape: 'sphere', radius: 0.4, offset: [0.8, 0, 0]},
  {shape: 'cylinder', halfHeight: 0.8, radius: 0.1, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2]},
]}});
const bowl = engine.createMesh().setGeometry(box(1, 0.5, 1)).setPosition([-6, 1, 0]); // your concave mesh
physics.addBody(bowl, {colliders: {shape: 'convexDecomposition'}});

// A four-wheeled car: wheels in the chassis frame (+Z forward, +Y up), wheel meshes as children of the chassis mesh.
const body = engine.createMesh().setGeometry(box(2, 0.5, 4)).setPosition([6, 1, 0]);
const chassis = physics.addBody(body, {colliders: {shape: 'box', halfExtents: [1, 0.25, 2], mass: 1000}});
const corners: [number, number, boolean][] = [[-0.9, 1.4, true], [0.9, 1.4, true], [-0.9, -1.4, false], [0.9, -1.4, false]];
const car = new Vehicle(physics, chassis, {
  wheels: corners.map(([x, z, steer]) => ({
    position: [x, -0.1, z] as [number, number, number],
    radius: 0.35,
    suspensionStiffness: 30,
    steer,
    mesh: engine.createMesh().setGeometry(box(0.25, 0.7, 0.7)).setParent(body),
  })),
});
const keys = {up: true, left: false, right: false, space: false}; // from your input handling
physics.on('beforestep', () => car.setInput({throttle: keys.up ? 1 : 0, steer: (keys.left ? 1 : 0) - (keys.right ? 1 : 0), brake: keys.space ? 1 : 0}));
engine.start();
console.log(car.speed, car.wheel(0).inContact, polyline.length);
```

- **Ropes.** `new Rope(physics, {start, end})` lays `segments` (default 12) capsule segments of `radius` (default 0.05) from `start` to `end` and links them end to end with spherical joints, so the rope bends but does not stretch. `attachStart` and `attachEnd` pin an end to a body (at that end's world point) or, with `'fixed'`, in place. Neighbouring segments do not collide; the rope collides with everything else. `damping` (0.1) and `angularDamping` (0.5) let a swinging rope settle; `collider` and `body` pass settings to every segment. `rope.points(out?)` writes the centre line as `segments + 1` points, `rope.segments` and `rope.joints` are the parts, and `rope.remove()` (or `using`) removes them and the fixed hooks.
- **Rope and spring joints.** `{type: 'rope', length}` keeps two anchors at most `length` apart (slack when closer). `{type: 'spring', restLength, stiffness, damping}` is a force spring (Hooke's law, N/m and N*s/m): a 2 kg weight on a 50 N/m spring hangs 0.39 m below its rest length.
- **Voxel worlds.** `{shape: 'voxels', cells}` is a grid of filled cells. Edit it in place with `collider.setVoxel(x, y, z, filled)`. Two grids that meet call `a.combineVoxelStates(b, sx, sy, sz)` once, where `sx`, `sy`, `sz` are the cells `b` is shifted by, and `a.propagateVoxelChange(b, x, y, z, sx, sy, sz)` after an edit on their border, so a body crosses the seam without catching. `physics.supportsShape('voxels')` says whether the solver has them: Rapier 0.17.1 or later. `@margoengine/voxel/physics` does all of this for a `VoxelWorld`.

  ```ts
  import { Physics } from '@margoengine/physics';

  await Physics.load();
  const physics = new Physics(null);
  const cells = Int32Array.of(0, 0, 0, 1, 0, 0, 2, 0, 0);
  const ground = physics.addBody(null, { type: 'fixed', colliders: { shape: 'voxels', cells, massless: true } });
  ground.colliders[0].setVoxel(1, 0, 0, false); // digs a hole, nothing is rebuilt
  ```

- **Compound colliders.** `{shape: 'compound', parts}` welds boxes, spheres, capsules, cylinders, cones and convex hulls, each with its own `offset` and `rotation`, into one collider: one handle, one contact pair per touching body, one set of material and filter settings. Parts are never fitted to the mesh, so each gives its size. For separate colliders with their own events, pass an array to `colliders` instead.
- **Convex decomposition.** `{shape: 'convexDecomposition'}` splits a concave triangle mesh (`geometry`, or `vertices` and `indices`, or the body's mesh) into convex pieces with Rapier's V-HACD, or takes the `parts` of the own `convexDecomposition` (see the own solver preview), so a dynamic cup stays hollow where a `convexHull` fills it in. `addModel(model, {shape: 'convexDecomposition'})` does it per primitive. It costs more to build than a hull; build it once and reuse the body.
- **Vehicles.** `new Vehicle(physics, chassis, {wheels})` wraps Rapier's ray-cast vehicle controller around a dynamic chassis. Each wheel casts its suspension along `direction` (default down) from its `position` every fixed step. `engineForce` (driven wheels), `steering` (radians around the chassis up axis, positive turns a +Z-facing car toward +X) and `brake` act on the wheels marked `drive` (default true), `steer` (default false) and `brake` (default true); `setInput({throttle, steer, brake})` maps normalized input onto `maxEngineForce` (default the chassis mass in newtons per driven wheel, so four driven wheels accelerate at 0.4 g), `maxSteeringAngle` (0.5 rad) and `maxBrakeForce` (0.05 x the mass). Throttle wakes a sleeping chassis. `speed` is the forward speed in m/s, `wheel(i)` the contact, suspension and spin state, and `wheelLocalPose(i)` the hub pose that wheel `mesh`es (children of the chassis mesh) receive after every sync. Suspension and tyre settings default to Rapier's values. `vehicle.dispose()` (or removing the chassis) removes the controller. Ropes and vehicles step and dispose with their world, and the `Physics` class never imports them, so a bundle that does not use them leaves them out.

## How it works

Static meshes loaded by `@margoengine/gltf-pro` or `@margoengine/fbx` support fitted colliders without attaching core geometry. `physics.addBody(model.root)` gathers the static core/PBR triangles beneath a geometry-free root into one fitted box, preserving the loaded hierarchy. Each descendant's world transform contributes its translation, rotation and scale; the collider uses the body's rotation/translation frame, retaining root scale exactly once because Rapier bodies have no scale. A node with its own geometry fits only that node, with its scale applied once. Hidden descendants still contribute collision geometry.

A body on a part below the root is fitted at that part's world scale. A skinned or morphed primitive rejects geometry-derived fitting with `Skinned mesh needs an explicit collider`; pass explicit dimensions or a capsule for animated characters. A root with no usable triangles throws `No geometry` and keeps no body. Use `colliders: []` for an intentionally colliderless body. Explicit collider dimensions, offsets and ownership keep their existing behavior.

- **One load per app.** Install the solver beside this package: `npm i @margoengine/physics @dimforge/rapier3d-compat`. It is an optional peer until Margo's own solver replaces it. `await Physics.load()` imports and compiles the solver, then `new Physics(engine)` stays synchronous. Wasm compiles asynchronously on the main thread, so that wait cannot live in a constructor. Later calls resolve at once, calls during a load share it, a failed load is tried again by the next call, and `{signal}` stops one caller's wait. A world made before the load throws a `MargoError` with code `state`. The solver stays a dynamic import, so its 1.6 MB (gzip) stays out of the first load of a page. It is a peer dependency that npm installs with this package (`rapier3d-compat` inlines its Wasm, so it works in any bundler without asset configuration); tested with `@dimforge/rapier3d-compat` 0.21.0. The `rapier` option still takes a module you initialized yourself, for another Rapier version.
- **Fixed timestep with an accumulator.** `onPreUpdate(delta)` adds `delta * timeScale` to an accumulator and runs whole steps of `fixedTimestep` (default 1/60 s), at most `maxSubsteps` (default 4) per frame. Time beyond that is dropped so a long hitch cannot snowball. Each step is identical regardless of frame rate, so a given sequence of inputs replays bit for bit.
- **Interpolation.** After each step the plugin stores the previous and current pose of every non-fixed body. Meshes get `lerp(previous, current, alpha)` for position and a shortest-arc slerp for rotation, where `alpha = accumulator / fixedTimestep`. Rendering therefore lags physics by less than one step and moves smoothly at any refresh rate. `interpolate: false` writes the latest step instead. Teleports (`body.setPosition`) reset both poses, so they do not streak.
- **Mesh writes.** `sync()` reuses preallocated position and quaternion buffers. It writes them with core's `setPosition` and `setQuaternion`, which allocate nothing. Sleeping or motionless bodies are written once and then skipped. Fixed bodies are written only when moved through the body API. Scale is never touched. Rapier stepping, events and scene queries are not allocation-free.
- **World space and parents.** Physics works in world space, so a body on a mesh below the root keeps its world pose: each frame it is written into the mesh's local transform through the parent's current world transform, with no frame of lag, parents before children when both have bodies. Nothing has to be flattened. A dynamic part falls off its model and stays where physics puts it, whatever its parent does. For a part that should move with its model and push things, use `{type: 'kinematicPosition', follow: true}`: before each step the body takes the mesh's world pose, and nothing is written back. `addModel(model, {perNode: true, type: 'kinematicPosition', follow: true})` does that for every part. Only a core `Mesh` can sit below a root; a mesh from another source must stay at the root.

  ```ts
  import { Engine, box } from '@margoengine/core';
  import { Physics } from '@margoengine/physics';

  await Physics.load();
  const engine = await Engine.create(document.querySelector('canvas')!);
  const physics = new Physics(engine);
  const base = engine.createMesh();
  const arm = engine.createMesh(base).setGeometry(box(1, 0.2, 0.2)).setPosition([0, 1, 0]);
  physics.addBody(arm, { type: 'kinematicPosition', follow: true, colliders: { shape: 'box', halfExtents: [0.5, 0.1, 0.1] } });
  base.setPosition([1, 0, 0]); // the body goes with the arm, and pushes what it meets
  ```
- **Disposed meshes.** A body whose mesh was disposed is removed at the next sync.
- **Colliders.** Shapes are built with Rapier's `ColliderDesc`. Boxes and spheres without a size, and convex hulls and trimeshes without points, are fitted to static mesh geometry (core `Geometry` interleaves position and normal, stride 6; raw arrays are packed xyz). A geometry-free root fits its static descendants, while a node with its own geometry uses that node. Scale is captured at collider creation. A mesh body without a `colliders` option gets one fitted box; an unsuccessful fit removes the new native body and any colliders already created.
- **Events.** Every collider emits collision events unless `events: false`. After each step the queue is drained and dispatched as `contactstart` and `contactend` (solid pairs) or `intersectionstart` and `intersectionend` (pairs with a sensor), with both bodies, both meshes and both Rapier colliders. Sensors also see kinematic and fixed bodies, so a character controller walking into a trigger fires it.
- **Contact filter.** `contactFilter(a, b)` installs Rapier physics hooks on every collider; returning false makes the pair pass through each other and suppresses its sensor events.
- **Debug drawing.** There is no built-in debug pass. `physics.debugRender()` returns Rapier's line buffers, which `@margoengine/lines` draws directly: `lines.add(new Line({mode: 'segments', positions: vertices, colors, width: 1}))`, updated each frame with `setPositions` and `setColors`.
- **Lifecycle.** `dispose()` (or `engine.removePlugin('physics')` or `engine.dispose()`) removes every character controller, joint, collider and body, then frees the event queue and the Rapier world. Handles become invalid (`body.valid === false`) and methods on them throw.
- **SSR safety.** Nothing touches `window`, `document`, `navigator` or GPU globals at import or construction time. `new Physics(null, {rapier})` runs headless, for servers, workers and tests; call `physics.update(delta)` yourself.

## API

| Export | Purpose |
| --- | --- |
| `Physics` | The world and engine plugin: `update`, `step`, `sync`, `addBody`, `addJoint`, `createCharacterController`, `raycast`, `raycastAll`, `shapeCast`, `projectPoint`, `intersectPoint`, `intersectShape`, `touching`, `contactPoints`, `on`, `debugRender`, `dispose`; `world` and `rapier` for anything not wrapped |
| `PhysicsBody` | Pose, teleport (`setPosition`, `setRotation`), kinematic targets (`setNextPosition`, `setNextRotation`), velocities, `addForce`, `applyImpulse` (optionally at a point), `addTorque`, `applyTorqueImpulse`, `resetForces`, `appliedForce`, `appliedTorque`, `setAdditionalMass`, `setMassProperties`, `mass`, `centerOfMass`, `principalInertia`, `inertiaFrame`, `additionalSolverIterations`, sleep and wake, `gravityScale`, `ccd`, locks, `addCollider`, `removeCollider`, `remove`, `colliders`; `raw` is the Rapier `RigidBody` |
| `PhysicsCollider` | What `body.colliders`, events and query hits hand you, one object per collider: `shape`, `body`, `handle`, `valid`, `boundingRadius`, read and set `friction`, `restitution`, `density`, `sensor`, `enabled`, `collisionGroups`, `solverGroups`; `translation`, `rotation`, `translationWrtParent`, `rotationWrtParent`, `halfExtents`, `radius`, `halfHeight`, `vertices`, `indices`, `containsPoint`; for `voxels`, `setVoxel`, `combineVoxelStates`, `propagateVoxelChange`. It throws a `state` error once removed. |
| `PhysicsJoint` | `setLimits`, `setMotor`, `setRotationMotor` (spherical joints: a spring toward a rotation), `setAxisLimits` and `setAxisMotor` (generic joints: one axis), `clearMotor`, `anchorA`, `anchorB`, `contactsEnabled`, `remove`; `raw` is the Rapier `ImpulseJoint` |
| `CharacterController` | `move(desired)` per fixed step, `grounded`, `dispose`; `raw` is Rapier's `KinematicCharacterController` |
| `Rope` | `new Rope(physics, options)`: `segments`, `joints`, `segmentLength`, `points(out?)`, `remove`, `valid` |
| `Vehicle` | `new Vehicle(physics, chassis, options)`: `engineForce`, `steering`, `brake`, `setInput`, `speed`, `wheel(i)`, `wheelLocalPose(i)`, `wheelCount`, `dispose`; `raw` is Rapier's `DynamicRayCastVehicleController` |
| `collisionGroups(memberships, filter)` | Packs interaction groups from group indices 0..15 or 16-bit masks |
| `geometryPositions(geometry, scale)` | Packed xyz positions from a core `Geometry` or raw arrays |
| `eulerToQuat(x, y, z)` | Core's XYZ Euler convention as a quaternion |

## Options

`new Physics(engine | null, options)`:

| Option | Default | Notes |
| --- | --- | --- |
| `rapier` | the one `Physics.load()` loaded | A Rapier module you initialized yourself; leave it out unless you need another version |
| `gravity` | `[0, -9.81, 0]` | Also `physics.gravity = [...]` |
| `fixedTimestep` | `1 / 60` | Seconds per step |
| `maxSubsteps` | `4` | Steps per frame before the backlog is dropped |
| `interpolate` | `true` | Interpolate meshes between steps |
| `timeScale` | `1` | Slow motion or fast forward |
| `paused` | `false` | Paused worlds keep their meshes but do not step |
| `solverIterations` | Rapier's (4) | More is stiffer stacks and joints. `physics.solverIterations` reads and sets it later; `body.additionalSolverIterations` (default 0) adds passes for that body's island alone |
| `contactFilter` | none | `(a, b) => boolean` per candidate pair |
| `name` | `'physics'` | Plugin name, for more than one world per engine |

`physics.addBody(mesh | null, options)`: `type` (`'dynamic'`, `'fixed'`, `'kinematicPosition'`, `'kinematicVelocity'`), `position`, `rotation` (quaternion; both default to the mesh), `colliders` (one or an array; `[]` for none), `linearVelocity`, `angularVelocity`, `linearDamping`, `angularDamping`, `gravityScale`, `ccd`, `canSleep`, `sleeping`, `lockRotations`, `lockTranslations`, `enabledRotations`, `enabledTranslations`, `additionalMass`, `dominance`, `follow`, `userData`.

Colliders: `shape` is `'box'` (`halfExtents`), `'sphere'` (`radius`), `'capsule'`, `'cylinder'` and `'cone'` (`halfHeight`, `radius`, Y axis; `borderRadius`, default 0, rounds the edges: Rapier's `roundCylinder` and `roundCone`), `'convexHull'` (`geometry` or `points`), `'trimesh'` (`geometry` or `vertices` and `indices`; `fixInternalEdges: true` lets a ball cross shared edges without catching), `'heightfield'` (`rows`, `columns`, `(rows + 1) * (columns + 1)` column-major `heights`, `scale` as the total size, centered on the body; `fixInternalEdges: true` as for a trimesh), `'compound'` (`parts`), `'convexDecomposition'` (`geometry` or `vertices` and `indices`), `'voxels'` (`cells`, an `Int32Array` of x, y, z cell coordinates, and `size`, one cell's size, default `[1, 1, 1]`), `'halfSpace'` (`normal`, out of the solid, default up) or `'custom'` (`desc`: a Rapier `ColliderDesc` you built, for what this wrapper does not cover; it leaves with Rapier; it keeps its own translation unless `offset` is given, and its contacts raise the same events as any other collider of the body). Plus `offset`, `rotation`, `friction`, `restitution`, `frictionCombine` and `restitutionCombine` (`'average'`, `'min'`, `'multiply'`, `'max'`), `density` or `mass`, `massless` (adds no mass or inertia and skips working them out, for the static pieces of a fixed body), `sensor`, `collisionGroups`, `solverGroups`, `events`, `enabled`.

Joints, `physics.addJoint(bodyA, bodyB, options)`: `type` `'fixed'` (`frameA`, `frameB` rotations), `'spherical'`, `'revolute'` or `'prismatic'` (`axis`, or `frameA` and `frameB` together; `limits`, `motor`), `'rope'` (`length`), `'spring'` (`restLength`, `stiffness`, `damping` default 0) or `'generic'` (below). All take `anchorA` and `anchorB` in each body's local frame and `contactsEnabled`. Motors take `targetVelocity`, `targetPosition`, `stiffness`, `damping` and `model` (`'acceleration'` or `'force'`).

A revolute or prismatic joint with frames turns or slides along the x axis of each frame. Line the frames up at rest and the rest pose reads 0, so `limits` count from it whatever the bodies' own rotations. Frames need Rapier 0.20 or later; an older one refuses them with a `MargoError` of code `unsupported`.

```ts
import { EngineKernel } from 'margoengine/core';
import { Physics } from 'margoengine/physics';

await Physics.load();
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!);
const physics = new Physics(engine);
const wall = physics.addBody(null, { type: 'fixed', colliders: [] });
const door = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [0.5, 1, 0.05] } });
// A quarter turn about z takes each frame's x axis to world y: the door swings about y, 0 to 1.5 radians from rest.
const upright = [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const;
physics.addJoint(wall, door, { type: 'revolute', frameA: upright, frameB: upright, anchorB: [-0.5, 0, 0], limits: [0, 1.5] });

physics.step();
console.log(physics.contactPoints(door)); // where the solver pushes on it: [x, y, z] per point
console.log(door.appliedForce, door.appliedTorque); // what addForce and addTorque left on it, until resetForces
```

A `'generic'` joint picks its six degrees of freedom, named `linX`, `linY`, `linZ`, `angX`, `angY` and `angZ` along and about the axes of its frame on body A: `locked` lists axes that do not move, `limits` gives an axis a `[min, max]`, `motors` gives one a motor, and any other axis is free. `frameA` and `frameB` turn the joint's frame on each body (default identity). Positions are measured from frame A to frame B. `joint.setAxisLimits(dof, min, max)` and `joint.setAxisMotor(dof, motor)` change them later. Rapier 0.20 or later.

```ts
import {Physics} from 'margoengine/physics';
await Physics.load();
const physics = new Physics(null);
const wall = physics.addBody(null, {type: 'fixed', colliders: []});
const door = physics.addBody(null, {position: [1, 0, 0], colliders: {shape: 'box', halfExtents: [1, 1, 0.05]}});
// A door hinge, opened by a spring toward 0.6 rad. The same lines run on the own solver, margoengine/physics/next.
physics.addJoint(wall, door, {
  type: 'generic',
  anchorB: [-1, 0, 0],
  locked: ['linX', 'linY', 'linZ', 'angX', 'angZ'],
  limits: {angY: [-1.5, 1.5]},
  motors: {angY: {targetPosition: 0.6, stiffness: 40, damping: 8}},
});
```

`joint.setRotationMotor(rotation, {stiffness, damping, model, maxForce, targetVelocity})` turns body B toward a rotation in body A's frame, on a spherical joint. With `model: 'force'`, a body of inertia I about the joint moves like a spring of frequency w and damping ratio z for `stiffness` I w² and `damping` 2 z I w; `maxForce` caps the torque in N m, on every motor; `targetVelocity` is the target's own spin. It moves the joint's frame on body A onto the target, because the solver cannot tell rotations apart near half a turn by their vector part. Rapier 0.20 or later.

Character controller options: `offset` (0.01), `up`, `maxSlopeClimbAngle` (45 degrees), `minSlopeSlideAngle` (30 degrees), `autostep` (`{maxHeight: 0.3, minWidth: 0.2}` or `false`), `snapToGround` (0.2 or `false`), `slide`, `applyImpulsesToDynamicBodies`, `characterMass`.

Queries take `maxDistance`, `solid`, `groups`, `exclude` (a body), `excludeSensors`, `excludeFixed`, `excludeKinematic`, `excludeDynamic` and `predicate(body, collider)`. Ray and shape-cast distances are along the normalized direction. Queries see the world as of the last step.

## Own solver preview

`@margoengine/physics/next` is Margo's own solver while it is built, a Rust kernel compiled to WebAssembly and shipped inside the package, so you need no toolchain and no peer install. Rapier stays the default until the switch; this entry is a preview and goes away then. Today it holds the kernel's world, its memory, bodies with colliders that move under forces, contacts, joints, and islands that sleep.

```ts
import {KernelWorld, loadKernel} from 'margoengine/physics/next';

await loadKernel();                     // once per app
const world = new KernelWorld(1024);    // rows of bodies; world.reserve(n) adds more
const body = world.addBody('dynamic');  // or 'fixed', 'kinematicPosition', 'kinematicVelocity'
const box = world.addCollider(body, 'box', [0.5, 0.5, 0.5], {density: 1000}); // 'ball' [r], 'capsule' [r, halfLength]
console.log(1 / world.columns.inverseMass[body]); // 1000 kg, worked out from the collider
world.columns.positionY[body] = 5;      // a column is a typed-array view of the kernel's memory
world.columns.impulseX[body] = 2;       // lands once, before the first substep
for (let i = 0; i < 60; i++) world.step(1 / 60);
console.log(world.columns.positionY[body], world.hash); // the hash is equal in every browser and in Node
```

Read views from `world.columns` each time: `reserve` and `addBody` can replace them. Each world is its own Wasm instance. Gravity defaults to `[0, -9.81, 0]` (`world.setGravity(x, y, z)`) and each step runs 8 substeps (`world.substeps`) of 2 solver passes (`world.iterations`). A force in `forceX` and the columns beside it stays until you clear it and reaches every substep; an impulse in `impulseX` lands once, before the first. A body's mass, centre of mass and inertia come from its colliders; write `additionalMass` and call `world.updateMass(body)` to add weight, which is spread as the colliders are, so it scales the inertia too. A dynamic body with no mass does not fall. `world.removeBody(body)` and `world.removeCollider(box)` free their rows, and a later add takes the last one freed; a collider's row comes back after the next step.

Each step finds pairs: `world.pairCount`, and `world.pairs()` for the collider rows, the lower first. A pair means two fat boxes overlap, where a fat box holds everything the step can reach plus 0.04 m, so a pair is near, not yet touching. Colliders of one body or of two fixed bodies are no pair. A step can grow the world, so read views after it, and call `world.touch(body)` after writing a fixed or sleeping body's pose by hand.

Bodies that touch form an island, and fixed and kinematic bodies join none, so two piles on one floor are two islands. A body is still when its kinetic energy per unit of mass stays under `world.sleepEnergy` (0.0002 J/kg, a slide of 0.02 m/s) for `world.sleepTime` (0.5 s) and has not risen across that time; a body under a force is never still. An island sleeps when all of it is still, and costs a step nothing until a body that moves touches it. `world.setSleep(energy, time)` changes both; `world.wake(body)`, `world.sleep(body)`, `world.isSleeping(body)` and `world.setCanSleep(body, false)` work per body; `world.awakeCount` and `world.islandCount` tell you what a step walks. Writing a sleeper's columns does not wake it, so call `wake` first.

```ts
import {KernelWorld, loadKernel} from 'margoengine/physics/next';

await loadKernel();
const world = new KernelWorld();
world.setGravity(0, 0, 0);
const body = world.addBody('dynamic');
world.addCollider(body, 'ball', [0.5]);
for (let i = 0; i < 40; i++) world.step(1 / 60);
console.log(world.isSleeping(body), world.awakeCount); // true 0
world.wake(body);
world.columns.linearX[body] = 2;
```

Each step then finds contact points between the near pairs of every shape: `world.contacts()` returns one manifold a pair, up to four points that share a normal from the first collider to the second. A `hull` is any closed convex polyhedron, added once with `world.addHull(vertices, faces)` and shared by every collider that names its row; its mass, centre and inertia come from the faces. Points follow the separating axis test: the touching faces are clipped against each other, so a box resting on a box has all four corners from its first step. A ball or capsule against anything goes by distance (GJK), and by the expanding polytope when its core is inside; a capsule lying along a face or another capsule gets two points.

```ts
import {KernelWorld, loadKernel} from 'margoengine/physics/next';

await loadKernel();
const world = new KernelWorld();
world.setGravity(0, 0, 0);
const pyramid = world.addHull(
  [[1, 0, 1], [1, 0, -1], [-1, 0, -1], [-1, 0, 1], [0, 1, 0]],
  [[3, 2, 1, 0], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
);
const floor = world.addBody('fixed');
world.addCollider(floor, 'box', [5, 0.5, 5], {density: 0});
const body = world.addBody('dynamic');
world.addCollider(body, 'hull', [pyramid]);
world.columns.positionY[body] = 0.49;
world.step(1 / 60);
const [contact] = world.contacts();
console.log(contact.normal, contact.points.length); // [0, 1, 0] 4
```

`Physics` and `PhysicsBody` from this entry keep the names of the root entry, on the own solver, so moving to it is one import. `Physics.load()` needs no peer; a mesh is optional, and an engine moves its meshes as the root entry does, with the same fixed step and interpolation.

```ts
import {Physics} from 'margoengine/physics/next';

await Physics.load();                  // once per app
const physics = new Physics(null);     // pass an engine to drive meshes; null runs without one
const body = physics.addBody(null, {
  position: [0, 5, 0],
  colliders: {shape: 'sphere', radius: 0.5, density: 1},
});
for (let i = 0; i < 60; i++) physics.step();
console.log(body.position[1]);         // fallen about 4.9 m in the second
physics.dispose();
```

It holds `box`, `sphere`, `capsule`, `convexHull`, `trimesh`, `heightfield`, `compound` and `voxels` colliders, bodies of every kind, forces, impulses, velocities, damping, locks, kinematic targets, gravity, sleeping and the `beforestep` and `afterstep` events. Bodies collide, with friction, restitution and the four combine rules, and `physics.touching(a, b)` and `physics.contactPoints(body)` read the contacts of the last step, walking only the asking body's pairs: `touching` allocates nothing, and a call costs that body's contacts, not the world's. Contact and intersection events, sensors, `collisionGroups`, `solverGroups`, `contactFilter`, `dominance` and `enabled` on bodies and colliders work as on the root entry, with the same names. `body.setType`, `setAdditionalMass` (with inertia of its own), `setMassProperties`, `collider.setDensity` and `additionalSolverIterations` work as on the root entry, with the same names and errors. A call that needs what is still to come throws a `MargoError` with code `unsupported` naming what it waits for: the other shapes and `addModel` with the shapes and queries batch, `follow` and character controllers, and `debugRender`. `body.sleep()` and impulses take effect at the next step.

`raycast` and `raycastAll` work on every shape the entry holds, with the root entry's names and options (`maxDistance`, `solid`, `groups`, `exclude`, `excludeSensors`, `excludeFixed`, `excludeKinematic`, `excludeDynamic`, `predicate`), plus Rapier's flags the root does not name: `excludeCollider`, `excludeSolids`, `onlyDynamic`, `onlyKinematic` and `onlyFixed`. `raycastAll` lists one hit a collider, nearest first, and `stop` ends the list early. Rays see the poses of the last step, as Rapier's do. A ray that starts inside a solid shape hits at distance 0 with a zero normal; with `solid: false` it hits where it leaves, the normal facing the ray.

```ts
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', colliders: {shape: 'box', halfExtents: [5, 0.5, 5]}});
const ball = physics.addBody(null, {position: [0, 3, 0], colliders: {shape: 'sphere', radius: 0.5}});
physics.step();                        // queries see the last step's poses
const hit = physics.raycast([0, 10, 0], [0, -1, 0], {maxDistance: 20});
console.log(hit?.body === ball, hit?.distance.toFixed(2)); // true '6.50'
const all = physics.raycastAll([0, 10, 0], [0, -1, 0]);
console.log(all.length);               // 2: the ball, then the floor
const floor = physics.raycast([0, 10, 0], [0, -1, 0], {exclude: ball});
console.log(floor?.normal);            // [0, 1, 0]
physics.dispose();
```

`shapeCast`, `projectPoint`, `intersectPoint` and `intersectShape` work on every shape the entry holds, with the root entry's names and the same filter options. The query shape is a `sphere`, `box`, `capsule` or `convexHull` with its size given; another shape throws a `MargoError` with code `unsupported`. `shapeCast` takes Rapier's cast options: `maxDistance` (default unbounded), `targetDistance` (stop this far short of touching, default 0), `stopAtPenetration` (default true: a cast that starts in contact hits at distance 0; false: one that starts in contact and moves out of it goes on) and `computeImpactGeometryOnPenetration` (default true: such a hit gets its normal and points; false leaves them zero). A hit gives the point and outward normal on the collider hit, and `queryPoint` and `queryNormal` on the cast shape. `projectPoint` takes `solid` (default true: a point inside a shape projects to itself, `inside` true, distance 0; false: to the nearest point of its surface). A trimesh or height field never holds a point.

```ts
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null, {gravity: [0, 0, 0]});
const wall = physics.addBody(null, {type: 'fixed', position: [5, 0, 0], colliders: {shape: 'box', halfExtents: [0.5, 2, 2]}});
physics.step();                        // queries see the last step's poses
const hit = physics.shapeCast({shape: 'sphere', radius: 0.5}, [0, 0, 0], [0, 0, 0, 1], [1, 0, 0]);
console.log(hit?.body === wall, hit?.distance.toFixed(2), hit?.normal); // true '4.00' [-1, 0, 0]
const short = physics.shapeCast({shape: 'sphere', radius: 0.5}, [0, 0, 0], [0, 0, 0, 1], [1, 0, 0], {targetDistance: 0.25});
console.log(short?.distance.toFixed(2)); // '3.75'
const nearest = physics.projectPoint([2, 1, 0]);
console.log(nearest?.point, nearest?.distance.toFixed(2)); // [4.5, 1, 0] '2.50'
console.log(physics.intersectPoint([5, 0, 0]).length);   // 1: the wall
console.log(physics.intersectShape({shape: 'box', halfExtents: [1, 1, 1]}, [3.6, 0, 0]).length); // 1
physics.dispose();
```

`ccd: true` on `addBody`, or `body.ccd = true`, turns on continuous collision for a body (default off), as Rapier's `enableCcd`: after each step a dynamic body that moved further than its thinnest piece is thick is swept from where the step began to where it ended and put back to its first touch, its velocity kept, so a fast thin body cannot pass a wall, a mesh or a height field. A slow body moves exactly as it would without it. `body.ccdActive` is true when the last step's sweep checked the body.

```ts
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null, {gravity: [0, 0, 0]});
physics.addBody(null, {type: 'fixed', position: [10, 0, 0], colliders: {shape: 'box', halfExtents: [0.01, 2, 2]}});
const bullet = physics.addBody(null, {linearVelocity: [300, 0, 0], colliders: {shape: 'sphere', radius: 0.02}, ccd: true});
physics.step();
console.log(bullet.ccdActive, bullet.position[0].toFixed(2)); // true '5.00'
for (let i = 0; i < 3; i++) physics.step();
console.log(bullet.position[0].toFixed(2)); // '9.97': stopped on the wall, not through it
physics.dispose();
```

Mesh writes on the own solver follow the kernel's awake list, so a sleeping or fixed body costs `sync()` nothing. A body
is written while it is awake and moves, once more when it comes to rest (its exact pose at rest), once after you place it
or change its type (`setPosition`, `setRotation`, `setType`, even with `wakeUp: false` or on a fixed body), and every sync
while its mesh is a child of another mesh, whose movement the body must undo. A resting body whose mesh you give a parent
is found by one read of the store's parents a sync, and written as a child from then on. Bodies on core meshes at the root
go to the engine in one `engine.writePoses` call a sync (same bits as `setPosition` and `setQuaternion`), children
through the setters after them, parents first. With 5,000 awake bodies a sync makes 1 engine call instead of 10,000 and
5,000 mesh lookups instead of 15,000; 150 sleepers among 200 bodies cost no lookup and no write (counted in
`tests/next-sync.test.js`; not timed yet). A body whose mesh was disposed is removed at the end of the sync.

`setType` keeps the pose, colliders and joints: a body made fixed stops, and its touches with other fixed bodies end; one made `kinematicPosition` holds its pose until given a target; a dynamic or kinematic body keeps its velocity. With `wakeUp` (default true) a body made dynamic or kinematic wakes now; a sleeper otherwise, or one made fixed, reads asleep until the next step, which wakes it and what it touches whatever `wakeUp` said, as on the root entry (measured). A kinematic body still for the sleep window reads asleep, as on Rapier, and a target wakes it. `setAdditionalMass(mass, inertia)` puts the mass at the centre of mass the body has now, so alone it leaves the inertia as it is, and replaces an earlier call, `setMassProperties` and the `additionalMass` option, which spreads its mass as the colliders are. `setMassProperties` sets the colliders' density to 0, and colliders added later add their own mass. `additionalSolverIterations` (any whole number from 0 to 4294967295, Rapier's 32 bits, on both entries) gives the body's island that many passes more: it runs as a world of that many passes would, bit for bit, and the other islands are left alone.

```ts
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [20, 0.5, 20]}});
// A crate held in place until it is let go, with a mass and inertia from a measurement.
const crate = physics.addBody(null, {type: 'fixed', position: [0, 0.5, 0], colliders: {shape: 'box', halfExtents: [0.5, 0.5, 0.5]}});
crate.setMassProperties({mass: 12, centerOfMass: [0, -0.2, 0], inertia: [2, 2, 2]});
crate.additionalSolverIterations = 4;   // a stiffer island, for a tall stack on top
crate.setType('dynamic');
for (let i = 0; i < 60; i++) physics.step();
console.log(crate.mass.toFixed(2), crate.position[1].toFixed(2)); // 12.00 0.50: on the floor it was touching
physics.dispose();
```

A `trimesh` takes `vertices` (flat x, y, z numbers) and `indices` (three a triangle, counter-clockwise seen from its front), or `geometry`, or the body's mesh, as on the root entry. It is a surface: both sides collide, and it adds no mass, so it belongs on fixed and kinematic bodies or with `setMassProperties`. Each triangle a shape touches holds its own contact normal, so a box in a corner keeps the floor and the wall. `fixInternalEdges: true` keeps contacts on the seams between triangles to the normals the surface allows, so a ball or a box slides across a flat run of triangles without catching on their inner edges; it is off by default, as in Rapier. `KernelWorld.addTrimesh(vertices, indices, {fixInternalEdges})` and `trianglesAcross(vertices, indices)` are the kernel's view of the same.

```js
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null);
// A 4 m square of ground from two triangles, and a ball dropped onto it.
const vertices = [-2, 0, -2, -2, 0, 2, 2, 0, -2, 2, 0, 2];
const indices = [0, 1, 2, 2, 1, 3];
physics.addBody(null, {type: 'fixed', colliders: {shape: 'trimesh', vertices, indices, fixInternalEdges: true}});
const ball = physics.addBody(null, {position: [0.3, 2, 0.2], colliders: {shape: 'sphere', radius: 0.5}});
for (let i = 0; i < 120; i++) physics.step();
console.log(ball.position[1].toFixed(2)); // 0.50: resting on the mesh
```

A `heightfield` takes the root entry's options, laid out as Rapier lays out its own: `rows` cells along z and `columns` along x, `(rows + 1) * (columns + 1)` `heights` column major (row r, column c is `heights[r + (rows + 1) * c]`), and `scale`, the whole field's width, height factor and depth, centred on the body. Each cell is two triangles split along the diagonal from row r + 1, column c to row r, column c + 1, the split Rapier makes; a test casts 300 rays at Rapier's field and finds the own field's surface within 2.2e-6 m of it. `fixInternalEdges` works as on a `trimesh` (off by default, as in Rapier) and the root entry takes it too. Like a trimesh it is a surface with no mass. The kernel keeps only the grid's points, 12 bytes each, and builds no tree, so a field of 500,000 cells is ready in milliseconds; `KernelWorld.addHeightfield(rows, columns, heights, scale, {fixInternalEdges})` is the kernel's view of it.

```js
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null);
// A 10 m square field of 2 by 2 cells with one raised corner, and a ball dropped on its flat part.
const heights = [0, 0, 0, 0, 0, 0, 0, 0, 1];
physics.addBody(null, {
  type: 'fixed',
  colliders: {shape: 'heightfield', rows: 2, columns: 2, heights, scale: [10, 2, 10], fixInternalEdges: true},
});
const ball = physics.addBody(null, {position: [-2.5, 2, -2.5], colliders: {shape: 'sphere', radius: 0.5}});
for (let i = 0; i < 120; i++) physics.step();
console.log(ball.position[1].toFixed(2)); // 0.50: resting on the field
```

A `compound` takes the root entry's `parts`: boxes, spheres, capsules, cylinders, cones and convex hulls, each with its own `offset` and `rotation` in the collider's frame, never fitted to the mesh. It is one collider, as in Rapier: one handle, one pair and one set of events against each other collider, and one `density` (or `mass`, spread by volume) for every part. Each part that touches keeps its own contact points and warm start, and parts are culled by their own boxes, so the gaps between them are empty. Its mass, centre and inertia match Rapier's for the same parts (a test holds them to 1e-5) and are the same bits as the parts added as colliders of their own. `boundingRadius` is null, as on the root entry. `KernelWorld.addCompound(body, parts, options)` is the kernel's view of it.

```js
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [10, 0.5, 10]}});
// A dumbbell: two balls on a bar, welded into one collider.
const dumbbell = physics.addBody(null, {
  position: [0, 3, 0],
  colliders: {
    shape: 'compound',
    parts: [
      {shape: 'sphere', radius: 0.5, offset: [-1, 0, 0]},
      {shape: 'sphere', radius: 0.5, offset: [1, 0, 0]},
      {shape: 'capsule', halfHeight: 0.5, radius: 0.1, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2]},
    ],
  },
});
for (let i = 0; i < 240; i++) physics.step();
console.log(dumbbell.colliders.length, dumbbell.position[1].toFixed(2)); // 1 0.50: one collider, resting on its balls
```

A `voxels` collider takes the root entry's `cells` (an `Int32Array` of x, y, z cell numbers, three per cell) and `size` (one cell, default `[1, 1, 1]`); cell (i, j, k) spans `[i, i + 1]` times the size along x, and so on. `setVoxel(x, y, z, filled)` edits it in place, keeping the contacts of every other cell, and a cell outside the grid grows it. Two grids that meet call `a.combineVoxelStates(b, sx, sy, sz)` once, `sx`, `sy`, `sz` the cells `b` is shifted by, and `a.propagateVoxelChange(b, x, y, z, sx, sy, sz)` after an edit on their border, so a body crosses the seam without catching; left uncoupled, the border is the side of a step and a sliding box catches on it, as on Rapier. A grid has the mass of its cells, so it can be a dynamic body; it meets every shape but triangle meshes and heightfields, which it falls through, as Rapier's does. Inside one grid a body slides across the cells without catching on the faces between them: a contact normal may lean only toward exposed faces. Its mass follows an edit at once (Rapier's at the next step). The kernel keeps one byte a cell over the box of the cells, so a sparse grid costs its box: split a large world into chunks. `KernelWorld.addVoxels(cells, size)` is the kernel's view of it.

```js
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null);
// A 4 by 4 slab of cells at y = 0, twice, side by side.
const slab = Int32Array.from(Array.from({length: 16}, (_, i) => [i >> 2, 0, i & 3]).flat());
const [a, b] = [0, 4].map(
  (x) => physics.addBody(null, {type: 'fixed', position: [x, 0, 0], colliders: {shape: 'voxels', cells: slab, friction: 0}}).colliders[0],
);
a.combineVoxelStates(b, 4, 0, 0); // b's cell (0, 0, 0) is a's (4, 0, 0)
a.setVoxel(3, 0, 0, false).propagateVoxelChange(b, 3, 0, 0, 4, 0, 0); // dig on the border, tell b
const crate = physics.addBody(null, {
  position: [2, 1.3, 2], linearVelocity: [3, 0, 0], canSleep: false,
  colliders: {shape: 'box', halfExtents: [0.3, 0.3, 0.3], friction: 0},
});
for (let i = 0; i < 60; i++) physics.step();
console.log(crate.position[0].toFixed(1), crate.position[1].toFixed(2)); // 5.0 1.30: across the seam at its height
```

A `convexHull` takes `points` (flat x, y, z numbers), or `geometry`, or the body's mesh when it has neither, scaled with the mesh, as on the root entry. The solver builds it by Quickhull: points inside, repeats and points within 2.5e-5 of the hull's size of a face are dropped, triangles in one plane become one face of up to 256 corners, and colliders built from the same points share one hull. `convexHull(points)` returns the `vertices` and `faces` it builds, for drawing or checking; it throws a `RangeError` naming the fix for fewer than four points or points that span no volume.

```ts
import {Physics, convexHull} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [20, 0.5, 20]}});
const points = [];
for (let i = 0; i < 12; i++) {
  const t = (i / 12) * 2 * Math.PI;
  points.push(Math.cos(t), -0.5, Math.sin(t), 0.5 * Math.cos(t), 0.5, 0.5 * Math.sin(t));
}
const rock = physics.addBody(null, {position: [0, 3, 0], colliders: {shape: 'convexHull', points, density: 2}});
for (let i = 0; i < 180; i++) physics.step();
console.log(rock.position[1].toFixed(2), convexHull(points).faces.length); // 0.50 14: resting on its wide face
physics.dispose();
```

A `cylinder` and a `cone` stand along their local Y, `halfHeight` each way, a cone's apex at the top. `borderRadius` rounds every edge with a border outside `radius` and `halfHeight`, Rapier's `roundCylinder` and `roundCone`, and `collider.borderRadius()` reads it back. A round shape weighs its border too, where Rapier weighs only its core, so give `mass` to match a Rapier scene's weights. A cap or base on a floor holds a full manifold, so the shape stands; rays, `shapeCast` and point queries meet the exact surface.

```ts
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [20, 0.5, 20]}});
const can = physics.addBody(null, {position: [0, 2, 0], colliders: {shape: 'cylinder', radius: 0.3, halfHeight: 0.5, borderRadius: 0.05}});
const cone = physics.addBody(null, {position: [2, 2, 0], colliders: {shape: 'cone', radius: 0.4, halfHeight: 0.3}});
for (let i = 0; i < 180; i++) physics.step();
console.log(can.position[1].toFixed(2), cone.position[1].toFixed(2)); // 0.55 0.30: on its rounded cap, on its base
physics.dispose();
```

After each step a pair that began or stopped touching fires `contactstart` or `contactend`, or `intersectionstart` or `intersectionend` when either collider is a sensor, with both bodies, meshes and colliders. A sensor sees overlaps and pushes nothing, and it sees kinematic and fixed bodies too. Two fixed bodies never meet, sensor or not. A collider stays quiet with `events: false` when the other side has it too. A pair of sleepers says nothing, and neither does a body removed while it touches, as on the root entry. `collisionGroups` keeps a pair apart; `solverGroups` lets it be seen and fire events without being solved. `contactFilter(a, b)` runs inside the step for each candidate pair of bodies: it may read the world and must not change it, so a step run from it throws, and false lets the pair pass and keeps its sensor events quiet. A body of higher `dominance` is a wall to a dynamic body of lower dominance, in contacts only, and floors still hold it. `body.enabled = false` takes a body out of the world: it keeps its pose and speed, nothing wakes it, its touches end and what rested on it falls, and its joints rest until it comes back, awake. `collider.setEnabled(false)` does the same for one collider, which keeps its mass.

```ts
import {Physics, collisionGroups} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null, {
  contactFilter: (a, b) => a.userData !== 'ghost' && b.userData !== 'ghost',
});
physics.addBody(null, {
  type: 'fixed',
  position: [0, -0.5, 0],
  colliders: {shape: 'box', halfExtents: [20, 0.5, 20], collisionGroups: collisionGroups([0], [0, 1])},
});
physics.addBody(null, {
  type: 'fixed',
  position: [0, 2, 0],
  colliders: {shape: 'box', halfExtents: [2, 0.25, 2], sensor: true},
});
const ball = physics.addBody(null, {
  position: [0, 5, 0],
  dominance: 1,
  colliders: {shape: 'sphere', radius: 0.3, collisionGroups: collisionGroups([1], [0])},
});
physics.on('intersectionstart', ({bodyA, bodyB}) => console.log('entered', bodyA === ball || bodyB === ball));
physics.on('contactstart', ({meshA, meshB}) => console.log('landed', meshA, meshB));
for (let i = 0; i < 120; i++) physics.step();
ball.enabled = false;
physics.dispose();
```

`physics.on('contactforce', listener)` says how hard two colliders pressed on each other: after each step with a listener, once a pair, with `bodyA`, `bodyB`, `meshA`, `meshB`, `colliderA`, `colliderB`, `impulse` (the normal impulse of the whole step, N s) and `force` (that over the step's length, N). A box at rest on a floor reads its weight, and the impulses of a landing add up to what stops it. A pair of sleepers is not solved, so it says nothing. Only the own solver has this event.

```ts
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [5, 0.5, 5]}});
physics.addBody(null, {position: [0, 3, 0], colliders: {shape: 'box', halfExtents: [0.5, 0.5, 0.5], mass: 3}});
let hardest = 0;
const stop = physics.on('contactforce', ({force}) => {
  hardest = Math.max(hardest, force);
});
for (let i = 0; i < 120; i++) physics.step();
stop();
console.log(hardest);                   // the landing, far above the 29.43 N of its weight
physics.dispose();
```

`physics.addJoint(bodyA, bodyB, options)` holds the root entry's `fixed`, `spherical`, `revolute`, `prismatic`, `rope` and `spring` joints, and `generic` joints, with `limits`, `motor`, `axis` or `frameA` and `frameB`, `locked`, `motors`, `contactsEnabled`, `joint.setLimits`, `setMotor`, `setRotationMotor`, `setAxisLimits`, `setAxisMotor`, `clearMotor`, `remove`, and the same errors. A joint keeps its two bodies from colliding unless `contactsEnabled` is true, and leaves with either body. A `generic` joint is the joint its locks make, bit for bit: all six are a `fixed` joint, the linear three a `spherical` one. An axis with one free turning axis reads its angle past a whole turn; with two or three free, each reads its part of the rotation vector from frame A to frame B. A limit or motor on a locked axis throws a `RangeError`, and `clearMotor` stops every axis's motor. A `rope` is slack inside its `length` and stops dead at it, and a `spring` is Hooke's law in implicit form, so any stiffness is stable, at the price of the decay implicit Euler brings: 1 / sqrt(1 + (w h)^2) a substep, about 23 percent of the amplitude in 10 s for a spring of 5 rad/s.

A joint that cannot be met stays calm rather than exact: a chain pulled straight between two walls and a little too short holds under 1 m/s, and an open joint closes at 3 m/s plus what the turning carries its anchors, so a body you move by hand comes back over several steps and does not jump past what is in the way. `docs/limits.md` gives what each limit costs. `world.step` and `physics.step` throw `MargoError` with code `failed` when a body goes past 1e15 in position or speed, which a true path can do: a bead free on a spinning rail flies out exponentially. The world keeps its last state and steps no more, so restore a snapshot or build it again with the joint limited.

```ts
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null);
const wall = physics.addBody(null, {type: 'fixed', colliders: []});
const door = physics.addBody(null, {
  position: [0.5, 0, 0],
  colliders: {shape: 'box', halfExtents: [0.5, 1, 0.05], density: 1},
});
const hinge = physics.addJoint(wall, door, {
  type: 'revolute',
  anchorB: [-0.5, 0, 0],                // the hinge line, in the door's frame
  axis: [0, 1, 0],
  limits: [-0.5, 0.5],                  // radians from the rest pose
  motor: {targetVelocity: 1, damping: 50},
});
for (let i = 0; i < 120; i++) physics.step();
console.log(door.rotation);             // turned half a radian about Y, against the limit
hinge.clearMotor();
physics.dispose();
```

A `cone` joint is the joint of a shoulder or a hip, and only the own solver has it. Its body's frame X stays within `swing` of the other's, as one angle or `[aboutY, aboutZ]` for an ellipse, and turns about that line within `twist` (leave it out to twist freely). `axis` is the middle of the cone, X by default, or give `frameA` and `frameB`. `joint.setCone(swing, twist)` changes it and `joint.cone` reads it.

```ts
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null);
const chest = physics.addBody(null, {type: 'fixed', colliders: []});
const arm = physics.addBody(null, {
  position: [0.3, 0, 0],
  colliders: {shape: 'capsule', radius: 0.05, halfHeight: 0.25},
});
const shoulder = physics.addJoint(chest, arm, {
  type: 'cone',
  anchorB: [-0.3, 0, 0],
  axis: [1, 0, 0],                      // the middle of the cone
  swing: [0.4, 1.2],                    // radians about frame Y and Z
  twist: [-0.5, 0.5],
});
for (let i = 0; i < 120; i++) physics.step();
console.log(shoulder.cone);             // {swing: [0.4, 1.2], twist: [-0.5, 0.5]}
physics.dispose();
```

Every limit, a cone's and a hinge's, stops its axis dead at the edge and holds any load there. An axis that starts past its edge, or is held there by a floor, is pushed back as a contact pushes out of a depth, so a limb that cannot reach its cone comes to rest where it lies. That push has the strength of the limb's own mass: a very light hand under an arm stays where the arm leaves it.

`joint.setRotationMotor(rotation, options)` drives a `spherical` joint toward a rotation of `bodyB` in `bodyA`'s frame, as on the root entry, and reads true near half a turn: the joint's frame on `bodyA` moves onto the target, so what is left to drive stays small. With `model: 'force'` a limb of inertia I about the joint moves like a spring of frequency w for `stiffness` I w^2 and `damping` 2 I w, `maxForce` caps the torque, and `targetVelocity` is the target's own spin, so a moving target is followed without lag.

```ts
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null, {gravity: [0, 0, 0]});
const shoulder = physics.addBody(null, {type: 'fixed', colliders: []});
const arm = physics.addBody(null, {
  colliders: {shape: 'box', halfExtents: [0.5, 0.05, 0.05], offset: [0.5, 0, 0], mass: 2},
});
const joint = physics.addJoint(shoulder, arm, {type: 'spherical'});
const w = 2 * Math.PI * 2, inertia = 2 / 3;       // 2 Hz; a 2 kg rod of 1 m about its end
joint.setRotationMotor([0, 0, Math.sin(0.5), Math.cos(0.5)], {
  model: 'force',
  stiffness: inertia * w * w,
  damping: 2 * inertia * w,
});
for (let i = 0; i < 60; i++) physics.step();
console.log(arm.rotation);                        // turned 1 rad about Z
joint.clearMotor();
physics.dispose();
```

Locks along a chain are solved exactly, so a chain of 50 hung straight holds a 1000 to 1 end mass to under 1e-5 of its length, at rest and swung at 3 m/s. A chain laid out level and let fall does not: the end mass swings it so taut that its light links turn faster than a substep can follow, and they stretch it from the second half second on (`docs/known-bugs.md`). A branch or a closed loop settles pass by pass, so it holds under its own weight and gives way a little under a far heavier body: the numbers are in `docs/limits.md`.

Each step is 8 substeps of 2 solver passes by default (`physics.substeps`, `physics.iterations`). `friction` defaults to 0.5, `restitution` to 0, and each combine rule to `average`; when two colliders ask for different rules the pair takes the higher, `max`, `multiply`, `min`, `average`. `collider.setFriction` and `collider.setRestitution` take effect at the next step.

```ts
import {Physics} from 'margoengine/physics/next';

await Physics.load();
const physics = new Physics(null);
const floor = physics.addBody(null, {
  type: 'fixed',
  colliders: {shape: 'box', halfExtents: [10, 0.5, 10], restitution: 0.5, restitutionCombine: 'max'},
  position: [0, -0.5, 0],
});
const ball = physics.addBody(null, {
  position: [0, 2.5, 0],
  colliders: {shape: 'sphere', radius: 0.5, density: 1, friction: 0.8},
});
let top = 0;
for (let i = 0; i < 45; i++) physics.step();      // down and off the floor again
for (let i = 0; i < 30; i++) {
  physics.step();
  if (ball.position[1] > top) top = ball.position[1];
}
console.log(top);                                 // about 1: the radius, and 0.5 squared of the 2 m drop
for (let i = 0; i < 600; i++) physics.step();
console.log(physics.touching(ball, floor));       // true
console.log(physics.contactPoints(ball).length);  // 1
physics.dispose();
```

A world is one block of memory, so a snapshot is one copy. `world.snapshot()` returns its bytes and `world.restore(bytes)` puts every row, pair and timer back, into a world of any size. A snapshot reads only in the kernel build that wrote it, and it covers the `KernelWorld`: a `Physics` object also holds bodies and meshes, so its restore comes with `/snapshot`.

```ts
import {KernelWorld, loadKernel} from 'margoengine/physics/next';

await loadKernel();
const world = new KernelWorld();
const body = world.addBody('dynamic');
world.addCollider(body, 'ball', [0.5]);
const saved = world.snapshot(),
  before = world.hash;
for (let i = 0; i < 60; i++) world.step(1 / 60);
world.restore(saved);
console.log(world.hash === before);    // true: stepping again gives the same run
```

Same calls in the same order with the same kernel build give bit-equal worlds. `world.hash` is a fingerprint of every byte of a world, and the replay test holds it equal over 10,000 steps in Node, native code, Chromium and Firefox. `world.setPose`, `world.setTarget` and `world.setLocks` are the checked ways to write a pose, a kinematic target and locked axes.

A concave mesh for a dynamic body goes through `convexDecomposition` from `margoengine/physics/decomposition`, its own entry, so a game that never decomposes never loads it. It takes a closed mesh (`vertices` and `indices`, or a geometry; equal positions are welded when the mesh is only closed after that, and one wound inside out is turned) and returns `{shape: 'convexDecomposition', parts, concavity}`, which is a collider on this entry and on the root one. It is the method of Wei, Liu, Ling and Su (ACM TOG 2022, CoACD): a part is cut by the axis plane a tree search over the next four cuts likes best, until each part's concavity, the larger of the widest gap between the part's surface and its hull's and 0.3 times the radius of a ball with the volume the hull adds, is under `concavity`, a share of the mesh's largest side (default 0.05); then neighbours that share a whole cut face merge while they stay under it. `maxConvexHulls` (default 64) caps the parts, cutting the least convex first; `planes` (20 per axis), `iterations` (500), `depth` (4) and `merge` (true) are the paper's settings; `seed` (0) makes a result repeat bit for bit; `timeLimit` (60,000 ms) stops it with a `timeout` `MargoError`, never a half-done answer. It is build-time work, seconds for a thousand triangles, so decompose once and keep the parts. `decompositionConcavity(mesh, parts)` scores any set of convex parts by the paper's measure, Rapier's included.

```ts
import {Physics} from 'margoengine/physics/next';
import {convexDecomposition} from 'margoengine/physics/decomposition';

// An open box, 2 m wide and 1 m tall with 0.1 m walls, as five slabs: the floor and four walls.
const vertices = [],
  indices = [];
for (const [x0, y0, z0, x1, y1, z1] of [
  [-1, 0, -1, 1, 0.1, 1],
  [-1, 0, -1, -0.9, 1, 1],
  [0.9, 0, -1, 1, 1, 1],
  [-1, 0, -1, 1, 1, -0.9],
  [-1, 0, 0.9, 1, 1, 1],
]) {
  const base = vertices.length / 3;
  for (let i = 0; i < 8; i++) vertices.push(i & 4 ? x1 : x0, i & 2 ? y1 : y0, i & 1 ? z1 : z0);
  for (const [a, b, c, d] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]])
    indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
}
const box = convexDecomposition({vertices, indices});

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [20, 0.5, 20]}});
physics.addBody(null, {colliders: box});
const marble = physics.addBody(null, {position: [0, 2, 0], colliders: {shape: 'sphere', radius: 0.2}});
for (let i = 0; i < 300; i++) physics.step();
console.log(box.parts.length, marble.position[1].toFixed(2)); // 8 0.33: inside the box, not on a lid
physics.dispose();
```

## Limits

- Scale from a parent that shears a part is not represented: a body has a position and a rotation. Mesh scale is read once when a geometry-derived collider is built.
- No built-in debug renderer; use `debugRender()` with `@margoengine/lines`.
- Not wrapped (reachable through `physics.world` and `physics.rapier`): multibody joints, contact force events, PID controllers, snapshots and serialization, voxel shapes, soft bodies and cloth.
- Ropes are rigid links, not soft bodies: a rope of many segments costs one body and one joint per segment. Compound colliders and convex decomposition need Rapier 0.19 or later, rope and spring joints and vehicles Rapier 0.12 or later; older versions throw a `MargoError` with code `unsupported` naming the upgrade.
- Changing `physics.gravity` wakes sleeping dynamic bodies, so they fall in the new field.
- A body removed while overlapping a sensor does not emit an end event.
- The engine passes `delta = 0` to `render()` unless you pass one, so a manual render loop must call `engine.render({delta})`; `engine.start()` does this for you.
- Joint limits are applied after creation with `setLimits`, because Rapier 0.21 ignores `JointData.limits` when creating impulse joints.

## Tests

Rapier 0.21.0 is installed as a root development dependency, so `npm test` and the root `npm run test:all` run the real simulation checks without skipped tests. `MARGOENGINE_RAPIER` can override the package folder for testing another installation.

```sh
npm install --prefix /tmp/rapier @dimforge/rapier3d-compat
MARGOENGINE_RAPIER=/tmp/rapier/node_modules/@dimforge/rapier3d-compat npm test
MARGOENGINE_RAPIER=/tmp/rapier/node_modules/@dimforge/rapier3d-compat npm run test:browser
```

`npm run test:replay` runs the replay in real browsers, Chromium and Firefox by default (`REPLAY_BROWSERS`), with no WebGPU, and fails unless each gives the hashes in `tests/fixtures/replay-hash.json`. `npm run test:browser` runs it too, in the browser the other suites use, so the full check holds it on every machine. `node scripts/replay-golden.mjs` rewrites that file after a kernel change; the native test and every browser must then match it. `REPLAY_FIREFOX` names a Firefox to run in place of Playwright's own, for a machine where that one will not start.

`npm test` runs Node checks against real Rapier, a minimal fake mesh and core's real transform storage: resting boxes, restitution, deterministic irregular frame times, accumulator and interpolation, slerped rotation, joints and motors, sensor events, scene queries, triangle meshes, heightfields and custom Rapier descs, mass and collision filters, forces and CCD, kinematic bodies, character movement and slopes, rope and spring joints, ropes (link lengths, pins, removal), compound colliders (one collider, mass, one contact pair, gaps between parts), convex decomposition against a convex hull (a marble inside a hollow cup), vehicles (suspension load, driving, steering direction, rolling spin, braking, reverse from sleep, wheel meshes), gravity changes waking sleepers, root-only validation, nested PBR/core collider fitting with negative and nonuniform scales, animated-source rejection, failure rollback, debug buffers, buffer reuse during synchronization, and complete disposal.

`npm run test:browser` uses a real WebGPU engine in Chromium (`BROWSER_CHANNEL`, `BROWSER_EXECUTABLE`, `BROWSER_ARGS` as in the other packages): a stack of five boxes falls and settles, rendered world matrices match the interpolated physics poses while falling with variable frame times, readback pixels at the projected box centers match each box's color, a raycast from the camera returns the middle box mesh, there are zero WebGPU validation errors, and `engine.dispose()` frees the world.

Rapier is Apache-2.0 and is not redistributed by this package.

Apache-2.0 licensed.
