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
- **Convex decomposition.** `{shape: 'convexDecomposition'}` splits a concave triangle mesh (`geometry`, or `vertices` and `indices`, or the body's mesh) into convex pieces with Rapier's V-HACD, so a dynamic cup stays hollow where a `convexHull` fills it in. `addModel(model, {shape: 'convexDecomposition'})` does it per primitive. It costs more to build than a hull; build it once and reuse the body.
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

Colliders: `shape` is `'box'` (`halfExtents`), `'sphere'` (`radius`), `'capsule'`, `'cylinder'` and `'cone'` (`halfHeight`, `radius`, Y axis), `'convexHull'` (`geometry` or `points`), `'trimesh'` (`geometry` or `vertices` and `indices`; `fixInternalEdges: true` lets a ball cross shared edges without catching), `'heightfield'` (`rows`, `columns`, `(rows + 1) * (columns + 1)` column-major `heights`, `scale` as the total size, centered on the body), `'compound'` (`parts`), `'convexDecomposition'` (`geometry` or `vertices` and `indices`), `'voxels'` (`cells`, an `Int32Array` of x, y, z cell coordinates, and `size`, one cell's size, default `[1, 1, 1]`), `'halfSpace'` (`normal`, out of the solid, default up) or `'custom'` (`desc`: a Rapier `ColliderDesc` you built, for what this wrapper does not cover; it leaves with Rapier; it keeps its own translation unless `offset` is given, and its contacts raise the same events as any other collider of the body). Plus `offset`, `rotation`, `friction`, `restitution`, `frictionCombine` and `restitutionCombine` (`'average'`, `'min'`, `'multiply'`, `'max'`), `density` or `mass`, `massless` (adds no mass or inertia and skips working them out, for the static pieces of a fixed body), `sensor`, `collisionGroups`, `solverGroups`, `events`, `enabled`.

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
// A door hinge, opened by a spring toward 0.6 rad.
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

`@margoengine/physics/next` is Margo's own solver while it is built, a Rust kernel compiled to WebAssembly and shipped inside the package, so you need no toolchain and no peer install. Rapier stays the default until the switch; this entry is a preview and goes away then. Today it holds the kernel's world, its memory, bodies with colliders that move under forces, the pairs of colliders that come near each other, and islands that sleep, with no contacts yet.

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

Read views from `world.columns` each time: `reserve` and `addBody` can replace them. Each world is its own Wasm instance. Gravity defaults to `[0, -9.81, 0]` (`world.setGravity(x, y, z)`) and each step runs 4 substeps (`world.substeps`). A force in `forceX` and the columns beside it stays until you clear it and reaches every substep; an impulse in `impulseX` lands once, before the first. A body's mass, centre of mass and inertia come from its colliders; write `additionalMass` and call `world.updateMass(body)` to add weight, which is spread as the colliders are, so it scales the inertia too. A dynamic body with no mass does not fall. `world.removeBody(body)` and `world.removeCollider(box)` free their rows, and a later add takes the last one freed; a collider's row comes back after the next step.

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

Each step then finds contact points between the near pairs of boxes and hulls: `world.contacts()` returns one manifold a pair, up to four points that share a normal from the first collider to the second. A `hull` is any closed convex polyhedron, added once with `world.addHull(vertices, faces)` and shared by every collider that names its row; its mass, centre and inertia come from the faces. Points follow the separating axis test: the touching faces are clipped against each other, so a box resting on a box has all four corners from its first step. Bodies do not push each other yet: that is job 4 of this batch.

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

It holds `box`, `sphere` and `capsule` colliders, bodies of every kind, forces, impulses, velocities, damping, locks, kinematic targets, gravity, sleeping and the `beforestep` and `afterstep` events. Bodies do not collide yet. A call that needs what is still to come throws a `MargoError` with code `unsupported` naming what it waits for: other shapes, `setType`, `setMassProperties`, inertia of its own, `ccd`, `follow`, `dominance`, disabling a body, `contactFilter`, friction, restitution and every other contact setting, joints, queries, character controllers, `addModel`, `touching`, `contactPoints`, contact events and `debugRender`. `body.sleep()` and impulses take effect at the next step.

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
