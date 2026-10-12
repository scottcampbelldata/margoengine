# @margoengine/physics

Rigid-body physics for Margo Engine on [Rapier](https://rapier.rs): a fixed-step engine plugin with interpolation, colliders, joints, scene queries, collision events and a character controller.

Not yet published to npm. Build from source with `npm run build` in `packages/physics`.

Covers what Babylon.js offers with its Havok plugin (`HavokPlugin`, `PhysicsAggregate`, `PhysicsBody`, `PhysicsShape*`, `Physics6DoFConstraint` and friends) and what `@react-three/rapier` gives Three.js users (`<Physics>`, `<RigidBody>`, collider components, joints, `useRapier` queries and events). Rapier is not bundled: you install `@dimforge/rapier3d-compat` (Apache-2.0) yourself and pass the initialized module in.

```ts
import RAPIER from '@dimforge/rapier3d-compat';
import {Engine, PbrMaterial, box} from '@margoengine/core';
import {Physics, collisionGroups} from '@margoengine/physics';

await RAPIER.init();
const engine = await Engine.create(canvas);
const physics = new Physics(engine, {rapier: RAPIER}); // registers itself with engine.use()

const floor = engine.createMesh().setGeometry(box(20, 1, 20)).setPosition([0, -0.5, 0]);
physics.addBody(floor, {type: 'fixed'});                 // box collider fitted to the geometry

const crate = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color: '#c08040'})).setPosition([0, 5, 0]);
const body = physics.addBody(crate, {colliders: {shape: 'box', restitution: 0.3, density: 2}});
body.applyImpulse([0, 2, 0]);

// Hinge with limits and a motor.
const door = physics.addBody(doorMesh, {colliders: {shape: 'box', halfExtents: [0.5, 1, 0.05]}});
physics.addJoint(frameBody, door, {type: 'revolute', anchorB: [-0.5, 0, 0], axis: [0, 1, 0], limits: [0, Math.PI / 2], motor: {targetVelocity: 1}});

// Queries return the core Mesh that was hit.
const hit = physics.raycast(engine.camera.position, [0, -1, 0]);
hit?.mesh; hit?.distance; hit?.point; hit?.normal;

// Events with the meshes involved.
physics.on('contactstart', ({meshA, meshB}) => {});
physics.on('intersectionstart', ({bodyA, bodyB}) => {}); // sensors

// Character controller on a kinematic capsule, driven once per fixed step.
const player = physics.addBody(playerMesh, {type: 'kinematicPosition', colliders: {shape: 'capsule', halfHeight: 0.5, radius: 0.3}});
const controller = physics.createCharacterController(player, {maxSlopeClimbAngle: Math.PI / 4, autostep: {maxHeight: 0.3, minWidth: 0.2}, snapToGround: 0.2});
physics.on('beforestep', dt => controller.move([input.x * 4 * dt, -9.81 * dt, input.z * 4 * dt]));

engine.start(); // each frame's delta drives the accumulator
// On teardown: physics.dispose(), engine.removePlugin('physics') or engine.dispose().
```

## How it works

- **Optional peer dependency.** The package never imports Rapier; `new Physics(engine, {rapier})` takes the initialized module, so the 1.6 MB (gzip) Rapier bundle stays out of builds that do not use physics and you choose the Rapier version and loading strategy (`rapier3d-compat` inlines its Wasm, so it works in any bundler without asset configuration). Tested with `@dimforge/rapier3d-compat` 0.21.0.
- **Fixed timestep with an accumulator.** `onPreUpdate(delta)` adds `delta * timeScale` to an accumulator and runs whole steps of `fixedTimestep` (default 1/60 s), at most `maxSubsteps` (default 4) per frame. Time beyond that is dropped so a long hitch cannot snowball. Each step is identical regardless of frame rate, so a given sequence of inputs replays bit for bit.
- **Interpolation.** After each step the plugin stores the previous and current pose of every non-fixed body. Meshes get `lerp(previous, current, alpha)` for position and a shortest-arc slerp for rotation, where `alpha = accumulator / fixedTimestep`. Rendering therefore lags physics by less than one step and moves smoothly at any refresh rate. `interpolate: false` writes the latest step instead. Teleports (`body.setPosition`) reset both poses, so they do not streak.
- **Mesh writes.** `sync()` reuses preallocated position and quaternion buffers. It uses `setPosition` and core's extension transform storage, avoiding the frozen core quaternion setter's temporary array. Sleeping or motionless bodies are written once and then skipped. Fixed bodies are written only when moved through the body API. Scale is never touched. Rapier stepping, events and scene queries are not allocation-free.
- **World space and parents.** Physics works in world space and writes world poses into the mesh's local transform, so **only root-level meshes may carry bodies**. `addBody` throws for a mesh with a parent, and `update` throws if a parent is assigned later. This keeps the write path exact and avoids a frame of lag from reading the parent's previous world matrix. To attach a physics object to a hierarchy, use a joint between two bodies, or give the parent the body and leave the children as purely visual meshes.
- **Disposed meshes.** A body whose mesh was disposed is removed at the next sync.
- **Colliders.** Shapes are built with Rapier's `ColliderDesc`. Boxes and spheres without a size, and convex hulls and trimeshes without points, are fitted to the mesh geometry (core `Geometry` interleaves position and normal, stride 6; raw arrays are packed xyz). Geometry-derived shapes take the mesh scale at creation. A body with a mesh that has geometry and no `colliders` option gets a fitted box.
- **Events.** Every collider emits collision events unless `events: false`. After each step the queue is drained and dispatched as `contactstart` and `contactend` (solid pairs) or `intersectionstart` and `intersectionend` (pairs with a sensor), with both bodies, both meshes and both Rapier colliders. Sensors also see kinematic and fixed bodies, so a character controller walking into a trigger fires it.
- **Contact filter.** `contactFilter(a, b)` installs Rapier physics hooks on every collider; returning false makes the pair pass through each other and suppresses its sensor events.
- **Debug drawing.** There is no built-in debug pass. `physics.debugRender()` returns Rapier's line buffers, which `@margoengine/lines` draws directly: `lines.add(new Line({mode: 'segments', positions: vertices, colors, width: 1}))`, updated each frame with `setPositions` and `setColors`.
- **Lifecycle.** `dispose()` (or `engine.removePlugin('physics')` or `engine.dispose()`) removes every character controller, joint, collider and body, then frees the event queue and the Rapier world. Handles become invalid (`body.valid === false`) and methods on them throw.
- **SSR safety.** Nothing touches `window`, `document`, `navigator` or GPU globals at import or construction time. `new Physics(null, {rapier})` runs headless, for servers, workers and tests; call `physics.update(delta)` yourself.

## API

| Export | Purpose |
| --- | --- |
| `Physics` | The world and engine plugin: `update`, `step`, `sync`, `addBody`, `addJoint`, `createCharacterController`, `raycast`, `raycastAll`, `shapeCast`, `projectPoint`, `intersectPoint`, `intersectShape`, `touching`, `on`, `debugRender`, `dispose`; `world` and `rapier` for anything not wrapped |
| `PhysicsBody` | Pose, teleport (`setPosition`, `setRotation`), kinematic targets (`setNextPosition`, `setNextRotation`), velocities, `addForce`, `applyImpulse` (optionally at a point), `addTorque`, `applyTorqueImpulse`, `resetForces`, sleep and wake, `gravityScale`, `ccd`, locks, `addCollider`, `removeCollider`, `remove`; `raw` is the Rapier `RigidBody` |
| `PhysicsJoint` | `setLimits`, `setMotor`, `clearMotor`, `contactsEnabled`, `remove`; `raw` is the Rapier `ImpulseJoint` |
| `CharacterController` | `move(desired)` per fixed step, `grounded`, `dispose`; `raw` is Rapier's `KinematicCharacterController` |
| `collisionGroups(memberships, filter)` | Packs interaction groups from group indices 0..15 or 16-bit masks |
| `geometryPositions(geometry, scale)` | Packed xyz positions from a core `Geometry` or raw arrays |
| `eulerToQuat(x, y, z)` | Core's XYZ Euler convention as a quaternion |

## Options

`new Physics(engine | null, options)`:

| Option | Default | Notes |
| --- | --- | --- |
| `rapier` | required | The module after `await RAPIER.init()` |
| `gravity` | `[0, -9.81, 0]` | Also `physics.gravity = [...]` |
| `fixedTimestep` | `1 / 60` | Seconds per step |
| `maxSubsteps` | `4` | Steps per frame before the backlog is dropped |
| `interpolate` | `true` | Interpolate meshes between steps |
| `timeScale` | `1` | Slow motion or fast forward |
| `paused` | `false` | Paused worlds keep their meshes but do not step |
| `solverIterations` | Rapier's (4) | More is stiffer stacks and joints |
| `contactFilter` | none | `(a, b) => boolean` per candidate pair |
| `name` | `'physics'` | Plugin name, for more than one world per engine |

`physics.addBody(mesh | null, options)`: `type` (`'dynamic'`, `'fixed'`, `'kinematicPosition'`, `'kinematicVelocity'`), `position`, `rotation` (quaternion; both default to the mesh), `colliders` (one or an array; `[]` for none), `linearVelocity`, `angularVelocity`, `linearDamping`, `angularDamping`, `gravityScale`, `ccd`, `canSleep`, `sleeping`, `lockRotations`, `lockTranslations`, `enabledRotations`, `enabledTranslations`, `additionalMass`, `dominance`, `userData`.

Colliders: `shape` is `'box'` (`halfExtents`), `'sphere'` (`radius`), `'capsule'`, `'cylinder'` and `'cone'` (`halfHeight`, `radius`, Y axis), `'convexHull'` (`geometry` or `points`), `'trimesh'` (`geometry` or `vertices` and `indices`) or `'heightfield'` (`rows`, `columns`, `(rows + 1) * (columns + 1)` column-major `heights`, `scale` as the total size, centered on the body). Plus `offset`, `rotation`, `friction`, `restitution`, `frictionCombine` and `restitutionCombine` (`'average'`, `'min'`, `'multiply'`, `'max'`), `density` or `mass`, `sensor`, `collisionGroups`, `solverGroups`, `events`, `enabled`.

Joints, `physics.addJoint(bodyA, bodyB, options)`: `type` `'fixed'` (`frameA`, `frameB` rotations), `'spherical'`, `'revolute'` or `'prismatic'` (`axis`, `limits`, `motor`). All take `anchorA` and `anchorB` in each body's local frame and `contactsEnabled`. Motors take `targetVelocity`, `targetPosition`, `stiffness`, `damping` and `model` (`'acceleration'` or `'force'`).

Character controller options: `offset` (0.01), `up`, `maxSlopeClimbAngle` (45 degrees), `minSlopeSlideAngle` (30 degrees), `autostep` (`{maxHeight: 0.3, minWidth: 0.2}` or `false`), `snapToGround` (0.2 or `false`), `slide`, `applyImpulsesToDynamicBodies`, `characterMass`.

Queries take `maxDistance`, `solid`, `groups`, `exclude` (a body), `excludeSensors`, `excludeFixed`, `excludeKinematic`, `excludeDynamic` and `predicate(body, collider)`. Ray and shape-cast distances are along the normalized direction. Queries see the world as of the last step.

## Limits

- Root-level meshes only (see above). Mesh scale is read once when a geometry-derived collider is built.
- No built-in debug renderer; use `debugRender()` with `@margoengine/lines`.
- Not wrapped (reachable through `physics.world` and `physics.rapier`): multibody joints, rope and spring joints, spherical-joint motors, contact force events, the ray-cast vehicle controller, PID controllers, snapshots and serialization, compound and voxel shapes, convex decomposition.
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

`npm test` runs 24 Node checks against real Rapier, a minimal fake mesh and core's real transform storage: resting boxes, restitution, deterministic irregular frame times, accumulator and interpolation, slerped rotation, joints and motors, sensor events, scene queries, triangle meshes and heightfields, mass and collision filters, forces and CCD, kinematic bodies, character movement and slopes, root-only validation, debug buffers, buffer reuse during synchronization, and complete disposal.

`npm run test:browser` uses a real WebGPU engine in Chromium (`BROWSER_CHANNEL`, `BROWSER_EXECUTABLE`, `BROWSER_ARGS` as in the other packages): a stack of five boxes falls and settles, rendered world matrices match the interpolated physics poses while falling with variable frame times, readback pixels at the projected box centers match each box's color, a raycast from the camera returns the middle box mesh, there are zero WebGPU validation errors, and `engine.dispose()` frees the world.

Rapier is Apache-2.0 and is not redistributed by this package.

MIT licensed.
