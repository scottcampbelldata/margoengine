# Physics: coming from other libraries

These notes map the physics examples and APIs of other web graphics libraries onto the `@margoengine/physics` package.
They sit here, outside the packages, because the clean-room rule keeps other engines out of package sources and READMEs
(`docs/clean-room.md`). Each section was moved word for word from the package README or the materials README.

## Rigid bodies, characters and vehicles

### From three.js and Rapier

The three.js Rapier examples (`physics_rapier_basic`, `physics_rapier_instancing`, `physics_rapier_terrain`) load
Rapier, make a world with a gravity, describe each body and collider with `RigidBodyDesc` and `ColliderDesc`, call
`world.step()` each frame, and copy every body's translation and rotation into its mesh (or into
`InstancedMesh.setMatrixAt`) themselves. In Margo:

| three.js + Rapier | Margo |
| --- | --- |
| `await RAPIER.init(); new RAPIER.World({x: 0, y: -9.81, z: 0})` | `await Physics.load(); new Physics(engine)` (gravity -9.81 m/s² by default; `physics.gravity`) |
| `world.createRigidBody(RigidBodyDesc.dynamic().setTranslation(x, y, z))` then `world.createCollider(ColliderDesc.ball(r), body)` | `physics.addBody(mesh, { position, colliders: { shape: 'sphere', radius: r } })`; `type: 'fixed'`, `'kinematicPosition'` or `'kinematicVelocity'` for the others |
| `world.step()` and `mesh.position.copy(body.translation())` every frame | nothing: the engine steps at a fixed rate and moves each body's mesh, interpolated |
| one body per instance, copied into `setMatrixAt` each frame | `new InstancedBodies(physics, instancedMesh, { colliders })` |
| `ColliderDesc.heightfield(rows, cols, heights, scale)` | `{ shape: 'heightfield', rows, columns, heights, scale }`, the same column-major layout |
| `world.castRay(new Ray(o, d), maxToi, true)` | `physics.raycast(o, d, { maxDistance })`, which returns the body, collider, point, normal and mesh |
| `body.applyImpulse({x, y, z}, true)` | `body.applyImpulse([x, y, z])` (arrays, and bodies wake by default) |

Rapier's own names (`setNextKinematicTranslation` is `setNextPosition`, `lockRotations`, `enableCcd` is `ccd`,
`collisionGroups`, `activeEvents` as `physics.on('contactstart')`) are listed row by row in
[docs/physics-collision-parity.md](physics-collision-parity.md).

### From three.js and Rapier

The three.js example `physics_rapier_character_controller` drives Rapier's `KinematicCharacterController` by hand:

```javascript
const controller = world.createCharacterController(0.01);
controller.enableAutostep(0.3, 0.2, false);
controller.enableSnapToGround(0.2);
controller.setApplyImpulsesToDynamicBodies(true);
// every frame: gravity and the jump are yours to integrate, and the mesh is yours to move
velocityY = grounded ? (jump ? 5 : 0) : velocityY - 9.81 * dt;
controller.computeColliderMovement(collider, { x: vx * dt, y: velocityY * dt, z: vz * dt });
const m = controller.computedMovement(), p = body.translation();
body.setNextKinematicTranslation({ x: p.x + m.x, y: p.y + m.y, z: p.z + m.z });
grounded = controller.computedGrounded();
mesh.position.copy(body.translation());
```

In Margo the same options are one object, the step is one call, and a body made with a mesh moves it (the quick start above is the whole program):

```typescript
const controller = physics.createCharacterController(body, { offset: 0.01, autostep: { maxHeight: 0.3, minWidth: 0.2 }, snapToGround: 0.2, applyImpulsesToDynamicBodies: true });
physics.on('beforestep', () => {
  if (jumpPressed) controller.jump(5);
  controller.walk([vx, 0, vz]);
});
```

`move(desired)` and Rapier's read-backs (`computedMovement()`, `computedGrounded()`, `numComputedCollisions()`,
`computedCollision(i)`) are there under the same names for code that keeps its own integration. Babylon's
`PhysicsCharacterController` is velocity-driven like `walk`: its `setVelocity` and `integrate(dt, support, gravity)` are
`walk(velocity)`, and its `checkSupport` is `grounded`, `groundNormal` and `platform`. A character that is a dynamic body,
pushed by the world, is `createDynamicCharacter`; a ragdoll that
takes over from either on a hit is `@margoengine/ragdoll/character`. A live page: `examples/character-controller.html`.

### Coming from the three.js Rapier vehicle example

three.js's `physics_rapier_vehicle_controller` example builds a Rapier `DynamicRayCastVehicleController` on the chassis's rigid body, adds each wheel with its chassis-local position, suspension direction, axle and suspension rest length and radius, sets each wheel's suspension stiffness, friction slip and steering, then every frame sets the engine force on the driven wheels, the brake on all and the steering on the front pair, calls the controller's update with the time step, and copies each wheel's translation, suspension length, steering and rotation into the wheel meshes itself. In Margo the same car is:

| three.js + Rapier example | Margo |
| --- | --- |
| `world.createVehicleController(chassis)`, then `addWheel(position, direction, axle, restLength, radius)` per wheel | `new Vehicle(physics, chassis, {wheels: [{position, direction, axle, suspensionRestLength, radius}]})`, or `Vehicle.car(physics, chassis)` for the four laid out and tuned |
| `setWheelSuspensionStiffness`, `setWheelFrictionSlip`, `setWheelSideFrictionStiffness`, `setWheelMaxSuspensionTravel`, `setWheelSuspensionCompression` and `Relaxation`, `setWheelMaxSuspensionForce` per wheel | the same names as wheel options: `suspensionStiffness`, `frictionSlip`, `sideFrictionStiffness`, `maxSuspensionTravel`, `suspensionCompression`, `suspensionRelaxation`, `maxSuspensionForce`, `rollInfluence` |
| `setWheelEngineForce`, `setWheelBrake`, `setWheelSteering` on chosen wheels each frame | `car.setInput({throttle, steer, brake})` from -1 to 1 (or `engineForce`, `brake`, `steering`), on the wheels marked `drive`, `brake` and `steer` |
| `vehicle.updateVehicle(dt)` before `world.step()` | nothing: the vehicle steps with the world at its fixed rate |
| `wheelChassisConnectionPointCs`, `wheelSuspensionLength`, `wheelSteering`, `wheelRotation` read back into each wheel mesh | `wheelMeshes` (or each wheel's `mesh`) are posed for you after every step; `car.wheelLocalPose(i)` gives the pose |
| `currentVehicleSpeed()`, `wheelIsInContact(i)`, `wheelContactPoint(i)` | `car.speed`, `car.wheel(i).inContact`, `car.wheel(i).contactPoint` (and `contactNormal`, `suspensionForce`, `forwardImpulse`, `sideImpulse`, `ground`) |
| `world.debugRender()` | `physics.debugRender()` for the colliders, plus `car.debugRender()` for the suspension rays, contacts, tyre slip and wheels |

The suspension and grip numbers mean what they mean in Rapier (stiffness and damping per kilogram of chassis, friction slip as a friction coefficient), so values tuned for the three.js example carry over; `next-vehicle.test.js` drives Margo's vehicle and Rapier's side by side on the same car.

## Force fields

Coming from Babylon: `helper.gravitationalField(origin, radius, strength, falloff)` is `new GravityField(physics,
{center, radius, acceleration})` (an acceleration, so a crate and a pebble fall in alike); `helper.updraft(origin,
radius, strength, height, mode)` and `helper.vortex(origin, radius, strength, height)` are `Updraft` and `Vortex` with
`strength` in newtons; the event's `enable()` and `disable()` are `enabled = true` and `false`, and its `dispose()` is
`remove()`. `applyRadialExplosionImpulse` is `explosion` above; a radial explosion force over one step is `explosion`
with `impulse` set to the force times `physics.fixedTimestep`. Bad input is a `MargoError` linked to
[its help entry](https://margoengine.com/errors#physics-fields).

## Instanced bodies

Coming from three.js: the `physics_rapier_instancing` example makes a Rapier body per instance and copies each body's translation and rotation into `InstancedMesh.setMatrixAt` every frame; here that loop is `InstancedBodies`, and `physics.raycast(...)?.body` with `crates.bodies.indexOf(body)` gives the instance index a pointer hit. Bad input is a `MargoError` linked to [its help entry](https://margoengine.com/errors#physics-instances).

## Instanced materials

Coming from three.js `InstancedFlow`: its offsets are fractions of a curve, so `moveAlongCurve(d)` is
`plugin.uniforms.progress += d`, `moveIndividualAlongCurve(i, d)` adds `d` to row `i` of
`instanceAttributes.array('progress')` (then `update('progress', i, 1)`), `setCurve(i, c)` keeps its name and
`updateCurve(c, curve)` is `setFlow(c, new CurveFlow(curve))`. It wraps on open curves too, which is `wrap: true`
here. Differences: edits upload by themselves (no `writeChanges`), and every instance keeps its own matrix.

## Cloth

#### Coming from three.js and Ammo cloth

three.js's `webgpu_compute_cloth` example builds the cloth by hand: storage buffers of vertices and of springs, compute functions for the Verlet step, the spring forces, a sphere collider and the wind, a render geometry that reads the vertex buffer, and the pointer moving the sphere. Its `physics_ammo_cloth` example makes a patch with `btSoftBodyHelpers.CreatePatch(corners, segments, fixed)`, tunes `get_m_cfg()` (iterations, damping, friction), sets its total mass, ties nodes to a rigid body with `appendAnchor(node, body, disableCollision, influence)`, adds it to the soft world, and every frame copies the nodes' positions and normals into a `BufferGeometry`. In Margo:

| three.js example | Margo |
| --- | --- |
| Vertex and spring storage buffers, built per cloth | `SoftBodyDesc.cloth(origin, du, dv, nu, nv)` (or `trimesh`), then `GPUCloth.attach(engine, desc)` |
| Verlet, spring and collision compute functions | built in: integrate, edge colours, tethers and colliders a substep |
| Spring stiffness | `stretchCompliance`, `shearCompliance`, `bendCompliance` (m/N) |
| A sphere uniform the pointer moves | `const ball = cloth.addCollider({shape: 'sphere', radius})`, then `ball.position = point` each frame; capsules, boxes, planes and SDF meshes too |
| Wind strength uniform | `wind` and `turbulence` |
| A render geometry over the vertex buffer | `drawGPUCloth(engine, cloth, {material})` |
| `CreatePatch(..., fixed)` | `SoftBodyDesc.cloth(...).setPinnedParticles([...])` |
| `setTotalMass`, `kDP`, `kDF` | `setMass`, `setLinearDamping`, `friction` |
| `appendAnchor(node, body)` | `cloth.attach(i, body)` on the GPU (one way), or `soft.create(desc).attachParticle(i, body)` on the CPU (two way) |
| Copy `m_nodes` into a `BufferGeometry` each frame | nothing: `drawGPUCloth` (GPU) or `drawSoftBody` (CPU) |
| Soft-world debug drawer | `PhysicsDebugView.add(cloth)`, or `view.add(() => soft.debugRender())` for the CPU cloth |

Self-contacts, tearing, two-way coupling with rigid bodies and water are the CPU cloth's (`soft.create`).

## Soft volumes

- **From three.js.** `physics_ammo_volume` builds an `Ammo.btSoftBody` from a `BufferGeometry` after merging its
  vertices by hand, sets `kPR` (pressure) or `kVC` (volume conservation) and the spring `kLST` on its config, adds it
  with `addSoftBody`, and copies `m_nodes` back into the geometry with its normals every frame. In Margo the same is
  `soft.create(SoftBodyDesc.volume(geometry, {stiffness, pressure}))` and `drawSoftBody(engine, body)`: the welding,
  the volume or gas, the mass from density and the drawing with normals are done for you, and the pressure is a real
  absolute pressure in Pa against the air outside, not a unitless coefficient.

## Breakable objects

Coming from three.js `physics_ammo_break`. That example does the breaking by hand around Ammo.js: it calls
`ConvexObjectBreaker.prepareBreakableObject(mesh, mass, velocity, angularVelocity, true)` on each object, walks Ammo's
dispatcher manifolds every frame, compares each contact point's `getAppliedImpulse()` with a fracture impulse, calls
`subdivideByImpact(mesh, point, normal, ...)` for the broken one, and then, for every piece it returns, builds a
`btConvexHullShape` from the piece's vertices, a `btRigidBody` with the piece's `userData.mass` and velocities, adds both
to the scene and the world, and removes the original. In Margo the same scene is the quick start above: `add()` once per
object, and the contact watch, the threshold (`bondStrength`, N s like the applied impulse), the convex hulls, the masses
(from the pieces' own volume and `density`) and the velocities are built in. What maps across:

| three.js + Ammo (`physics_ammo_break`) | Margo |
| --- | --- |
| `prepareBreakableObject(mesh, mass, v, w, true)` | `breakable.add(mesh, { density })`; then `body.body.setLinearVelocity(v)` |
| fracture impulse checked against `getAppliedImpulse()` per contact | `bondStrength` per bond, from every contact automatically (`minImpactImpulse` filters taps) |
| `subdivideByImpact(mesh, point, normal, ...)` | `fractureMode: 'impact'` (cells cluster around the hit), or `'prefractured'` |
| `btConvexHullShape` and `btRigidBody` per piece, by hand | made for you: `event.fragments[i].body` and `.mesh` in `onBreak` |
| `userData.mass` from the piece's volume | `fragment.mass`, exact polyhedral mass, inertia and centre of mass |
| pieces never break again unless marked breakable | `secondaryFracture: true` (default); `anchors` keep a base standing |
| removing debris yourself | `maxDebris`, `debrisLifetime` and debris sleep |

## Joints

Coming from three.js and Rapier. The three.js Rapier examples make a joint from a description and a world call, then copy
each body's pose into its mesh every frame: `world.createImpulseJoint(RAPIER.JointData.revolute(anchor1, anchor2, axis),
body1, body2, true)`, then `joint.setLimits(min, max)` and `joint.configureMotorVelocity(speed, factor)`, and in the loop
`mesh.position.copy(body.translation())` and `mesh.quaternion.copy(body.rotation())`. In Margo the joint is one call with
its limits and motor as options, and a body made with a mesh (`physics.addBody(mesh, options)`) moves it for you. What
maps across:

| Rapier through three.js | Margo |
| --- | --- |
| `JointData.fixed`, `.spherical`, `.revolute`, `.prismatic`, `.rope`, `.spring`, `.generic` | `type: 'fixed'`, `'spherical'`, `'revolute'`, `'prismatic'`, `'rope'`, `'spring'`, `'generic'` |
| `world.createImpulseJoint(data, body1, body2, true)` | `physics.addJoint(body1, body2, options)` |
| `world.createMultibodyJoint(...)`, one per link | `physics.addMultibody(root, links)`, the tree at once |
| `joint.setLimits(min, max)` | `limits: [min, max]` or `joint.setLimits(min, max)`; any axis: `setAxisLimits(dof, min, max)` |
| `configureMotorVelocity(speed, factor)` | `motor: { targetVelocity: speed, damping: factor }` |
| `configureMotorPosition(target, stiffness, damping)` | `motor: { targetPosition: target, stiffness, damping }` |
| a motor's force cap | `maxForce` on the motor |
| `joint.setContactsEnabled(true)` | `contactsEnabled: true`, or `joint.contactsEnabled = true` |
| copying `translation()` and `rotation()` into each mesh | `physics.addBody(mesh, options)` moves the mesh |
| `world.debugRender()` | `physics.debugRender({ jointFrames: true })`, the same `{ vertices, colors }` |
