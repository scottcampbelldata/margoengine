# @margoengine/physics

Import `margoengine/physics` from the `margoengine` package, or `@margoengine/physics` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Rigid-body physics for Margo Engine on its own Rust kernel (compiled to WebAssembly with SIMD, shipped inside the package): a fixed-step engine plugin with interpolation, colliders (compound and convex-decomposed ones included), joints (rope and spring included), ropes and chains, ray-cast vehicles, scene queries, collision events and a character controller.

Build from source with `npm run build` in `packages/physics`.

It exports `Physics` (the world: bodies, colliders, joints, queries and events), `PhysicsBody`, `PhysicsJoint`, `CharacterController`, `Vehicle` and `Rope`. The React components in `@margoengine/react/physics` are `<Physics>`, `<RigidBody>`, the collider components (`CuboidCollider`, `BallCollider` and others), `useJoint`, `usePhysics`, `useBeforePhysicsStep` and `useAfterPhysicsStep`. The solver comes with this package, nothing else to install: the kernel's WebAssembly is a blueprint inside the JavaScript, compiled by `await Physics.load()`.

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
import {convexDecomposition} from 'margoengine/physics/decomposition';

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
const bowlVertices = new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 0, 1, 0]); // your closed concave mesh
const bowlIndices = new Uint32Array([0, 2, 1, 0, 3, 2, 0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]);
const bowl = engine.createMesh().setPosition([-6, 1, 0]);
physics.addBody(bowl, {colliders: convexDecomposition({vertices: bowlVertices, indices: bowlIndices})});

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
- **Voxel worlds.** `{shape: 'voxels', cells}` is a grid of filled cells. Edit it in place with `collider.setVoxel(x, y, z, filled)`. Two grids that meet call `a.combineVoxelStates(b, sx, sy, sz)` once, where `sx`, `sy`, `sz` are the cells `b` is shifted by, and `a.propagateVoxelChange(b, x, y, z, sx, sy, sz)` after an edit on their border, so a body crosses the seam without catching. `physics.supportsShape('voxels')` says whether the solver has them (it always does). `@margoengine/voxel/physics` does all of this for a `VoxelWorld`.

  ```ts
  import { Physics } from '@margoengine/physics';

  await Physics.load();
  const physics = new Physics(null);
  const cells = Int32Array.of(0, 0, 0, 1, 0, 0, 2, 0, 0);
  const ground = physics.addBody(null, { type: 'fixed', colliders: { shape: 'voxels', cells, massless: true } });
  ground.colliders[0].setVoxel(1, 0, 0, false); // digs a hole, nothing is rebuilt
  ```

- **Compound colliders.** `{shape: 'compound', parts}` welds boxes, spheres, capsules, cylinders, cones and convex hulls, each with its own `offset` and `rotation`, into one collider: one handle, one contact pair per touching body, one set of material and filter settings. Parts are never fitted to the mesh, so each gives its size. For separate colliders with their own events, pass an array to `colliders` instead.
- **Convex decomposition.** `convexDecomposition({vertices, indices})` from `margoengine/physics/decomposition` splits a closed concave triangle mesh into convex pieces after CoACD (Wei et al., ACM TOG 2022), and its result is a collider (`body.addCollider(result)`): a dynamic cup stays hollow where a `convexHull` fills it in. `addModel(model, {shape: 'convexDecomposition'})` does it per primitive. It is build-time work, so decompose once and keep the parts; the world never loads it.
- **Vehicles.** `new Vehicle(physics, chassis, {wheels})` puts a ray-cast vehicle (a spring and damper per wheel, drive and brake force, tyre grip inside a friction circle) on a dynamic chassis. Each wheel casts its suspension along `direction` (default down) from its `position` every fixed step. `engineForce` (driven wheels), `steering` (radians around the chassis up axis, positive turns a +Z-facing car toward +X) and `brake` act on the wheels marked `drive` (default true), `steer` (default false) and `brake` (default true); `setInput({throttle, steer, brake})` maps normalized input onto `maxEngineForce` (default the chassis mass in newtons per driven wheel, so four driven wheels accelerate at 0.4 g), `maxSteeringAngle` (0.5 rad) and `maxBrakeForce` (3 x the mass, newtons per braking wheel). Throttle wakes a sleeping chassis. `speed` is the forward speed in m/s, `wheel(i)` the contact, suspension and spin state, and `wheelLocalPose(i)` the hub pose that wheel `mesh`es (children of the chassis mesh) receive after every sync. Suspension and tyre settings default to a soft road car (stiffness 5.88, compression 0.83, relaxation 0.88, friction slip 10.5). Each wheel's `rollInfluence` (0 to 1, default 0.1) is how much of its height above the ground the sideways grip turns the chassis by: at 0.1 a car with grippy tyres takes a bend without tipping over, at 1 the grip pushes at the tyre and a light car rolls. `wheel(i)` also gives the `ground` collider the wheel stands on, the `hardPoint` where its suspension is mounted in the world, and the `forwardImpulse` and `sideImpulse` it pushed the chassis with in the last step. `forward` in the vehicle's options (default `[0, 0, 1]`) is the direction a chassis faces, in its own frame, so `speed` is the velocity along it for a car that faces another way (give its wheels the matching `axle`, `up x forward`). `vehicle.dispose()` (or removing the chassis) detaches it. Ropes and vehicles step and dispose with their world, and the `Physics` class never imports them, so a bundle that does not use them leaves them out.

## Drag joint

`new DragJoint(physics, body, point, {frequency = 5, damping = 0.7, maxForce})` grabs a dynamic body at a world point and pulls that point toward a target, as a mouse joint does (the soft constraint of Catto, GDC 2011, as a frequency and a damping ratio, so a light body and a heavy one follow the pointer alike). Move the target with `setTarget(point)`, read the grabbed point with `gripPoint()`, and let go with `remove()` (removing the body lets go too). `maxForce` caps the pull in newtons so a far target cannot hurl a body.

```ts
import {DragJoint, Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
const crate = physics.addBody(null, {position: [0, 2, 0], colliders: {shape: 'box', halfExtents: [0.25, 0.25, 0.25], mass: 4}});
const drag = new DragJoint(physics, crate, [0.1, 2, 0], {frequency: 5, damping: 1});
drag.setTarget([1.5, 3, 0]); // from a pointer ray, each frame
for (let i = 0; i < 120; i++) physics.step();
console.log(crate.position, drag.gripPoint());
drag.remove();
```

## Soft bodies

Ropes, cloth and particle meshes live in their own entry, `margoengine/physics/soft`, so a game that never imports it pays nothing: the root entry does not load it, and its kernel (a small Rust program compiled to Wasm) is a chunk of its own. Particles are held by compliant distance constraints (XPBD, Macklin, Müller and Chentanez 2016) solved in many small steps (Macklin et al. 2019); they collide with every shape of the rigid world (balls, boxes, capsules, cylinders, cones, hulls, meshes, height fields, voxels, compounds and half spaces; the rigid world is asked once a step for up to four planes each particle may meet, each collider swept along its own motion so a fast paddle cannot pass a particle, a deformable mesh's vertex speeds counted for friction, and sensors left out), and the bodies they press on take the impulse back, shared by the body's inverse mass and inertia, so a light crate on cloth sinks it and a heavy one sinks it more.

```ts
import {Physics} from 'margoengine/physics';
import {SoftBodies, SoftBodyDesc, SoftBodyMaterial} from 'margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null);
const soft = await SoftBodies.attach(physics); // loads the soft kernel once per app

// A rope of 20 particles pinned at one end, a 12 x 12 cloth pinned at its four corners.
const rope = soft.create(SoftBodyDesc.rope([0, 4, 0], [2, 4, 0], 20).setPinnedParticles([0]));
const cloth = soft.create(
  SoftBodyDesc.cloth([-0.55, 1, -0.55], [0.1, 0, 0], [0, 0, 0.1], 12, 12)
    .setPinnedParticles([0, 11, 132, 143])
    .setParticleMass(0.02)
    .setLinearDamping(3),
);
physics.addBody(null, {position: [0, 1.4, 0], colliders: {shape: 'box', halfExtents: [0.1, 0.1, 0.1], density: 400}});

soft.onTear(({body, edges}) => console.log('torn', body.handle, edges));
for (let i = 0; i < 300; i++) physics.step();
const positions = cloth.particlePositions(); // flat x, y, z, a copy
console.log(positions.length / 3, rope.particlePosition(19));

// Tear a rope that stretches past 20%, pull a particle along with a kinematic target, then let go.
const fragile = soft.create(SoftBodyDesc.rope([3, 4, 0], [3, 2, 0], 6).setEdgeTearResistance(0.2));
fragile.setParticleKinematicTarget(0, [3, 4.02, 0]);
fragile.setParticlePinned(0, false);
```

- **Builders.** `SoftBodyDesc.rope(start, end, particles, {bending})`, `cloth(origin, du, dv, nu, nv)` (particle (i, j) is at `origin + i*du + j*dv`, index `i * nv + j`; structural, shear and bend edges) `clothTube`, `clothAnisotropic(origin, du, dv, nu, nv)` (a woven sheet whose warp runs along `du` and weft along `dv`; the material's `warpSoftness`, `weftSoftness`, `shearSoftness` and `bendSoftness` each give a spring and a damping ratio, and left out they are `edgeSoftness`, so `cloth` is the isotropic case: after Thomaszewski et al. 2006 for the bend and Baraff and Witkin 1998 and Wang et al. 2011 for the separate stretch and shear), `trimesh(vertices, indices)` (edges along the triangles, bend edges across shared edges, shape matching on, `body.triangles()` gives the mesh back), or `new SoftBodyDesc(positions)` with `setEdges` and `setBendEdges` for any other particle mesh. `append` merges two descriptions and `addEdges` sews them, with the rest length the distance at insertion.
- **Settings.** `setPinnedParticles`, `setParticleMass`, `setMass`, `setMasses`, `setParticleRadius` (default half the shortest edge), `setSoftness(hertz, dampingRatio)`, `setMaterial(SoftBodyMaterial)`, `setEdgeTearResistance(strain)`, `setCollisionGroups(word)` (a collider's packed `collisionGroups`: which colliders the particles meet), `SoftBodyDesc.sphere(center, radius, {detail})` (a ball of triangles that holds its volume) with `setVolumeFactor(f)` on the description and on the body (`f` times the volume at creation: 1 keeps it, above 1 inflates; the spring is the material's `volumeSoftness`, default exact) and `body.surfaceVolume()`, `setTensionOnly(true | edges)` (edges that resist stretch and not squeeze: a slack rope does not push, a taut one pulls; also on the body), `setSelfContacts(on, {friction})` (the body's triangles, and those of other bodies that have it on, keep a particle radius apart with Coulomb friction between the layers: cloth falling on cloth stays outside it, found before it passes through by the continuous point-triangle and edge-edge search of the shared kernel library, Bridson et al. 2002, Harmon et al. 2008), `setShapeMatching(on)` (every particle is pulled toward its place in the best-fit rotated rest shape, Müller et al. 2005, with the rotation found as in Müller et al. 2016; `shapeMatchingSoftness` on the material sets the spring, 0 Hz holds it rigid), `setGravityScale`, `setLinearDamping`, `setTranslation`. A natural frequency of 0 makes an edge rigid, the default for stretch edges (the rigid edges of a rope or a tree, and the rigid link of a body hung from it, are solved exactly, so how far it stretches does not depend on `iterations`, `substeps` or the mass of the load; a sheet's loops keep the sweep, whose stiffness does); bend edges default to 10 Hz.
- **Particles.** `particlePosition(i)`, `particlePositions()`, `particleVelocity(i)`, `particleVelocities()`, `setParticlePosition` (a teleport), `setParticleVelocity`, `setParticlePinned`, `setParticleKinematicTarget` (a pinned particle that travels to the target over the next step, so contacts and friction see it move), `attachParticle(index, rigidBody)` and `detachParticle(index, body?)` (a point-to-point link at the particle's place now: the body carries the particle and takes its pull back, shared by inverse mass and inertia, so a rope hangs a crate), `edges()`, `bendEdges()`, `isEdgeTorn`, `tearEdge`.
- **Forces.** `addForce`, `addParticleForce`, `resetForces`, `applyImpulse` (shared by mass), `applyParticleImpulse` and `applyImpulseAtPoint(impulse, point, radius)` (linear falloff to zero at `radius`, the whole impulse when the radius is zero or less) and `applyRadialImpulse(center, magnitude, radius)` (outward from the centre, the same falloff; all divided by each particle's mass). Pinned particles ignore them.
- **Deformable colliders.** `soft.createDeformableCollider(body, {vertices, indices}, binding, settings)` makes a deformable triangle-mesh collider of any mesh whose vertices follow the body, with their speeds, by `SoftMeshBinding.direct(particles)` (vertex `i` is particle `particles[i]`), `SoftMeshBinding.directByPosition(eps)` (each vertex is the nearest particle within `eps` metres) or `SoftMeshBinding.skinned()` (each vertex rides the tetrahedral cell that holds it); it goes with the body. A body with a skin (`setSkin`) collides by its skin: `soft.createSurfaceCollider(body)` uses the skin's mesh.
- **Surface collider.** `soft.createSurfaceCollider(body, {friction})` gives a body made from triangles (`trimesh`, `cloth`, `clothTube`) a deformable triangle-mesh collider that follows its particles each step with each vertex's speed, so every rigid shape, convex hulls and meshes included, rests on cloth and is dragged by its friction; particles meet every shape directly through the kernel's swept particle probe. It is removed with the body.
- **World.** `soft.create`, `soft.remove`, `soft.list()`, `soft.onTear(listener)`, `soft.hash()` (equal across two runs that did the same), `soft.substeps` (default 8) and `soft.iterations` (default 2), `soft.dispose()`.

### Solid bodies: tetrahedral cells, plasticity, tearing and clusters

A body made of tetrahedral cells behaves as an elastic solid. Each cell holds the shape its four particles stood in when the body was made, and two constraints on its deformation gradient carry the elasticity: the stable Neo-Hookean energy of Smith, de Goes and Kim (2018) in the constraint form of Macklin and Müller (2021), where an inverted cell comes back and nothing locks near zero volume, or, as an option, the co-rotated linear elasticity of Müller and Gross (2004). Both are solved by XPBD in the same small steps as the edges, so the cells' stiffness is real: a cantilever of Young's modulus E sags by the Euler-Bernoulli deflection rho g A L^4 / (8 E I) as its mesh is refined (a coarse mesh of linear tetrahedra locks and reads stiff: 8 by 2 cells give 55 percent of it, 12 by 3 give 88, 16 by 4 give 99), and a near-incompressible rubber (Poisson's ratio 0.49) keeps its volume within 3 percent under a 30 percent stretch where a foam (0.05) grows with it.

```ts
import {Physics} from 'margoengine/physics';
import {CellMaterial, SoftBodies, SoftBodyDesc} from 'margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null);
const soft = await SoftBodies.attach(physics, {substeps: 20, iterations: 8}); // a stiff body wants more small steps

// A beam of rubber that bends for good past 2 percent strain and tears past 80, held at one end.
const material = new CellMaterial();
material.youngsModulus = 3e6; // pascals; the default is 1e5, a soft rubber
material.poissonRatio = 0.3; // below 0.5; near it the body keeps its volume
material.yieldStrain = 0.02; // plastic flow: 0, the default, is elastic all the way
material.tearStrain = 0.8; // 0, the default, never tears
const beam = SoftBodyDesc.box([0, 1, 0], [1, 0.25, 0.25], [8, 2, 2], material);
const held = [];
for (let i = 0; i < beam.particleCount; i++) if (beam.positions[i * 3] === 0) held.push(i);
const body = soft.create(beam.setPinnedParticles(held).setLinearDamping(4));
soft.cellDamping = 20; // how fast the cells take out the speed along their constraints, per second (default 10)

soft.onTear(({body: torn, cells}) => console.log('torn', torn.handle, cells));
for (let i = 0; i < 360; i++) physics.step();
console.log(body.volume() / body.restVolume(), body.tornCells().length);
```

- **Builders.** `SoftBodyDesc.box(origin, size, counts, material)` cuts a block into cubes of equal side, each into six tetrahedra around a diagonal (Kuhn's triangulation, which matches across faces); particle (i, j, k) has index `(i * (ny + 1) + j) * (nz + 1) + k`. `SoftBodyDesc.solid(origin, cell, counts, inside, material)` keeps only the cubes whose centre `inside(x, y, z)` accepts, which carves a ball, a ring or a statue out of the grid and drops the particles no kept cube uses. `new SoftBodyDesc(positions).setCells(tets, material)` takes any tetrahedral mesh, four particle indices a cell (a left-handed cell has its last two corners swapped; a flat one throws a `RangeError`). `append` merges bodies with their cells and clusters.
- **Material** (`CellMaterial`, a copy is taken). `youngsModulus` (pascals, default 1e5), `poissonRatio` (0 to under 0.5, default 0.3), `model` (`'neo-hookean'` by default, `'corotated'`, or `'volume'`: one constraint on each cell's volume held by the bulk modulus, with the shape left to the edges, so build it with `desc.addCellEdges()`; it never flows or tears), `elasticDampingRatio` (damping as a share of critical for the cell's own shear wave, default 0) and `deformationDamping` (the speed the constraints lose each second, default `soft.cellDamping`), `density` (kg/m3, default 1000: when no mass is set the cells give each particle its share, and `setMass`, `setParticleMass` and `setMasses` take over), `yieldStrain` (also `plasticYield`), `creep` (also `plasticCreep`) and `plasticMax` (plastic flow and its cap), `tearStrain`, `tearSmoothing` and `interiorStrength`. `desc.setCellMaterial`, `body.setCellMaterial` and `body.getCellMaterial` change it, at once, on a body that exists; a cell keeps the shape it has flowed into.
- **Plasticity.** The elastic deformation gradient splits from a plastic one (Bargteil, Wojtan, Hodgins and Turk 2007; Irving, Teran and Fedkiw 2004), the plastic part folded into the cell's rest shape. When the deviatoric part of a cell's stretch, in Frobenius norm, passes `yieldStrain`, the excess goes into the rest shape (all at once for a `creep` of 0, else `creep` per second), so the body keeps a set when the load goes and keeps its volume while it flows. A plastic cantilever loaded and released keeps more than a third of its sag; an elastic one returns. `plasticMax` caps how far a cell may flow in all. Edges flow too: `SoftBodyMaterial.edgePlasticYield` (a fraction of the rest length), `edgePlasticCreep`, `edgePlasticMax` (a fraction of the first length) and `edgePlasticFlow` (`'compression'`, `'stretch'` or `'both'`) move an edge's rest length past its yield. `body.resetPlasticity()` takes back every permanent change, cells and edges.
- **Tearing.** A cell whose stretch strain (the Frobenius norm of the stretch minus identity) passes `tearStrain` is removed at the end of the step and stays torn; the cells around it hold what is left. `onTear` listeners get `{body, edges, cells}`, `body.tornCells()`, `isCellTorn(cell)`, `tearCell(cell)`, `cells()` (four particle indices a cell), `numCells()`, `volume()` (cells not torn, as they stand) and `restVolume()` read and change it. A bar torn clean through is two pieces, joined by no cell. A tear that parts a body makes pieces of it (`soft.splitOnTear`: `'cells'` by default, `'all'` to split rope-like bodies of edges too, `'never'`): the cells that tore part from every cell they were joined to and, with the torn cells they touch, go on as pieces of their own, so no volume or mass is lost, the particles along a crack are duplicated, one for each side that meets there (the virtual nodes of Molino, Bao and Fedkiw 2004), and each part that no longer joins another becomes a soft body of its own with the rest shapes, plastic flow, rest lengths and masses of what it took, so the old body is removed and its tear event carries `pieces` and `destination(particle)` (where each of its particles went: both sides of a crack). `soft.tear(body, {cells, edges})` tears what you name at once and splits; `soft.cut(body, [a, b, c])` cuts along a triangle blade: every face between cells on the two sides of the blade's plane that lies inside the blade is parted, cells are not cut in two, and no material is removed. A body of edges with triangles (cloth, a trimesh) splits too: each piece takes the triangles whose corners and sides it holds, its self contacts and a surface collider of its own (the old one goes with the old body); a crack that does not part the cloth leaves its triangles out. A body of cells with triangles or a surface collider is not split, and shape matching and the volume constraint do not carry to pieces. The tear can be shaped: `SoftBodyMaterial.tearForce` tears a structural edge pulled harder than that many newtons; `tearSmoothing` (on both materials, seconds) smooths the load so a spike does not tear; `CellMaterial.interiorStrength` makes a cell with no outside face and no torn neighbour that much tougher, so a tear starts at the surface or at damage; `maxTearsPerStep` caps the elements a body tears in a step, the most loaded first (a load past twice its threshold tears regardless); `minPiece` makes a tear that would split off fewer cells than that wait.
- **Clusters.** `desc.setClusters(groups, hertz)` holds each group of particles to its rest shape by shape matching (Müller, Heidelberger, Teschner and Gross 2005), turned and moved to where the group stands, as an implicit spring of `hertz`, so it is stable at any stiffness; groups may overlap and the cells may be soft. A block twisted by 0.6 rad and let go with a cluster returns to its shape within 0.1 mm; without one the twist stays in.
- **World.** `soft.cellDamping` (per second, default 10) damps every cell's constraints so a struck body stops ringing; `soft.substeps` and `soft.iterations` set the small steps as for edges: a stiff body wants more (the cantilever test uses 20 and 20, the example above 20 and 8).

- **Builders from meshes.** `SoftBodyDesc.volumetric(vertices, indices, size, skinned)` fills a closed, outward triangle mesh with cells of `size` metres (every lattice cube that holds or touches the mesh is kept, so the body contains the mesh); `cuboid(centre, halfExtents, counts)` is `box` by centre. `setSkin(vertices, indices)` binds a mesh to the cells that hold its vertices (barycentric coordinates in the cell); `body.meshVertices()` and `meshIndices()` read it back for drawing. The skin follows the cells and does not collide.
- **Clusters and frames.** `body.addCluster(indices, hertz = 0)` makes a cluster (its number comes back), `numClusters()` counts them, `removeCluster(cluster)` removes one. A cluster has a frame, its centre and the rotation that best fits its particles (Müller et al. 2005): `body.clusterProxy(cluster)` is a dynamic rigid body standing at it, with the cluster's mass and velocity and no gravity, that you can join (`physics.addJoint(anchor, proxy, ...)` holds the cluster up) or give colliders; the rigid world's change to its velocity is handed to the particles at the next step. `body.rootBody()` is the proxy of a cluster of every particle. Per cluster: `setClusterStiffnessScale` (Young's modulus of the cells wholly inside), `setClusterEdgeSoftness`, `setClusterTearResistance`, `enableClusterShapeMatching(cluster, on, hertz)`, `setClusterPinned`, `setClusterKinematicTarget(cluster, position, rotation)` (every particle goes to its place in the pose, pinned there).

- **The implicit solver.** `desc.setSolver('fem')` (or `body.setSolver`) holds a body's cells with one linear solve a substep, the linearly implicit step of Baraff and Witkin (1998) with the co-rotated stiffness of each cell and a conjugate gradient solve that never forms a matrix, instead of the constraints: its stiffness does not depend on the substeps and passes (a cantilever sags by the same 88 percent of the Euler-Bernoulli deflection at one substep of one pass as at eight of four, where the constraints with one pass sag more than twice as far, and a beam of 2 GPa holds at one substep), so use it for very stiff materials. `soft.femLinearTolerance` (relative residual, default 1e-5), `soft.femMaxLinearIterations` (default 20) and `soft.femMaxDenseDofs` (default 600: a body with that many unknowns or fewer is iterated until its residual is gone, as many passes as it has unknowns if need be, as a direct solve would finish) tune it. It works on the Neo-Hookean (forces of the stable Neo-Hookean stress, the stiffness of the co-rotated one: a quasi-Newton step to the same state) and co-rotated models; `'volume'` cells are always constraints, and the `Fem` bodies share the step with every other body.

Not in this entry yet: collision through a skin (see `docs/physics-collision-parity.md` for each row).

## How it works

Static meshes loaded by `@margoengine/gltf/pbr` or `@margoengine/fbx` support fitted colliders without attaching core geometry. `physics.addBody(model.root)` gathers the static core/PBR triangles beneath a geometry-free root into one fitted box, preserving the loaded hierarchy. Each descendant's world transform contributes its translation, rotation and scale; the collider uses the body's rotation/translation frame, retaining root scale exactly once because a body has no scale. A node with its own geometry fits only that node, with its scale applied once. Hidden descendants still contribute collision geometry.

A body on a part below the root is fitted at that part's world scale. A skinned or morphed primitive rejects geometry-derived fitting with `Skinned mesh needs an explicit collider`; pass explicit dimensions or a capsule for animated characters. A root with no usable triangles throws `No geometry` and keeps no body. Use `colliders: []` for an intentionally colliderless body. Explicit collider dimensions, offsets and ownership keep their existing behavior.

- **One load per app.** `await Physics.load()` compiles the solver, then `new Physics(engine)` stays synchronous. Wasm compiles asynchronously on the main thread, so that wait cannot live in a constructor. Later calls resolve at once, calls during a load share it, a failed load is tried again by the next call, and `{signal}` stops one caller's wait. A world made before the load throws a `MargoError` with code `state`. The kernel is a deflated blueprint inside the package's JavaScript, so there is no Wasm file to serve, no bundler plugin and no peer install; it is inflated and compiled by `Physics.load()`.

  ```ts
  import { Physics } from '@margoengine/physics';

  await Physics.load({ signal: AbortSignal.timeout(30_000) });
  const physics = new Physics(null, { gravity: [0, -9.81, 0] });
  physics.dispose();
  ```
- **Fixed timestep with an accumulator.** `onPreUpdate(delta)` adds `delta * timeScale` to an accumulator and runs whole steps of `fixedTimestep` (default 1/60 s), at most `maxSubsteps` (default 4) per frame. Time beyond that is dropped so a long hitch cannot snowball. Each step is identical regardless of frame rate, so a given sequence of inputs replays bit for bit.
- **Interpolation.** After each step the plugin stores the previous and current pose of every non-fixed body. Meshes get `lerp(previous, current, alpha)` for position and a shortest-arc slerp for rotation, where `alpha = accumulator / fixedTimestep`. Rendering therefore lags physics by less than one step and moves smoothly at any refresh rate. `interpolate: false` writes the latest step instead. Teleports (`body.setPosition`) reset both poses, so they do not streak.
- **Mesh writes.** `sync()` reuses preallocated position and quaternion buffers. It writes them with core's `setPosition` and `setQuaternion`, which allocate nothing. Sleeping or motionless bodies are written once and then skipped. Fixed bodies are written only when moved through the body API. Scale is never touched. Stepping allocates nothing; events, scene queries and the vehicle and character helpers allocate their results.
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
- **Colliders.** Boxes and spheres without a size, and convex hulls and trimeshes without points, are fitted to static mesh geometry (core `Geometry` interleaves position and normal, stride 6; raw arrays are packed xyz). A geometry-free root fits its static descendants, while a node with its own geometry uses that node. Scale is captured at collider creation. A mesh body without a `colliders` option gets one fitted box; an unsuccessful fit removes the new body and any colliders already created.
- **Events.** Every collider emits collision events unless `events: false`. After each step the queue is drained and dispatched as `contactstart` and `contactend` (solid pairs) or `intersectionstart` and `intersectionend` (pairs with a sensor), with both bodies, both meshes and both colliders. Sensors also see kinematic and fixed bodies, so a character controller walking into a trigger fires it.
- **Contact filter.** `contactFilter(a, b)` is asked for every candidate pair; returning false makes the pair pass through each other and suppresses its sensor events, and returning `'noForces'` (Rapier's hook answering with no solver flags) finds the pair's contacts and fires its events but pushes nothing.
- **Debug drawing.** There is no built-in debug pass. `physics.debugRender()` returns line buffers (boxes, spheres, capsules, cylinders and cones as themselves, every other shape as the box around it), which `@margoengine/lines` draws directly: `lines.add(new Line({mode: 'segments', positions: vertices, colors, width: 1}))`, updated each frame with `setPositions` and `setColors`.
- **Lifecycle.** `dispose()` (or `engine.removePlugin('physics')` or `engine.dispose()`) removes every character controller, joint, collider and body, then the world. Handles become invalid (`body.valid === false`) and methods on them throw.
- **SSR safety.** Nothing touches `window`, `document`, `navigator` or GPU globals at import or construction time. `new Physics(null)` runs headless, for servers, workers and tests; call `physics.update(delta)` yourself.

## API

| Export | Purpose |
| --- | --- |
| `Physics` | The world and engine plugin: `update`, `step`, `sync`, `addBody`, `addJoint`, `createCharacterController`, `raycast`, `raycastAll`, `shapeCast`, `projectPoint`, `intersectPoint`, `intersectShape`, `touching`, `contactPoints`, `on`, `debugRender`, `dispose`; `kernel` is the solver's world, with its columns, `hash`, `snapshot` and `restore` |
| `PhysicsBody` | Pose, teleport (`setPosition`, `setRotation`), kinematic targets (`setNextPosition`, `setNextRotation`), velocities, `addForce`, `addForceAtPoint`, `applyImpulse`, `applyImpulseAtPoint` (both forms take a point too), `addTorque`, `applyTorqueImpulse`, `resetForces`, `resetTorques`, `appliedForce`, `appliedTorque`, `setAdditionalMass`, `setMassProperties`, `mass`, `centerOfMass`, `principalInertia`, `inertiaFrame`, `additionalSolverIterations`, sleep and wake, `gravityScale`, `ccd`, locks (`lockTranslations`, `lockRotations`, `enabledTranslations`, `enabledRotations`), `addCollider`, `removeCollider`, `remove`, `colliders` |
| `PhysicsCollider` | What `body.colliders`, events and query hits hand you, one object per collider: `shape`, `body`, `handle`, `valid`, `boundingRadius`, read and set `friction`, `restitution`, `density`, `sensor`, `enabled`, `collisionGroups`, `solverGroups`; `translation`, `rotation`, `translationWrtParent`, `rotationWrtParent`, `halfExtents`, `radius`, `halfHeight`, `vertices`, `indices`, `containsPoint`; for `voxels`, `setVoxel`, `combineVoxelStates`, `propagateVoxelChange`. It throws a `state` error once removed. |
| `PhysicsJoint` | `setLimits`, `setMotor`, `setRotationMotor` (spherical joints: a spring toward a rotation), `setAxisLimits` and `setAxisMotor` (generic joints: one axis), `clearMotor`, `anchorA`, `anchorB`, `contactsEnabled`, `remove` |
| `CharacterController` | `move(desired)` per fixed step, `grounded`, `collisions`, `dispose` |
| `Rope` | `new Rope(physics, options)`: `segments`, `joints`, `segmentLength`, `points(out?)`, `remove`, `valid` |
| `Vehicle` | `new Vehicle(physics, chassis, options)`: `engineForce`, `steering`, `brake`, `setInput`, `speed`, `wheel(i)`, `wheelLocalPose(i)`, `wheelCount`, `dispose` |
| `collisionGroups(memberships, filter)` | Packs interaction groups from group indices 0..15 or 16-bit masks |
| `interactionGroups(memberships, filter, testMode)` | Interaction groups 32 bits wide with a test mode, `'and'` or `'or'`, for `collisionGroups`, `solverGroups` and query `groups` |
| `geometryPositions(geometry, scale)` | Packed xyz positions from a core `Geometry` or raw arrays |
| `eulerToQuat(x, y, z)` | Core's XYZ Euler convention as a quaternion |

## Options

`new Physics(engine | null, options)`:

| Option | Default | Notes |
| --- | --- | --- |
| `gravity` | `[0, -9.81, 0]` | Also `physics.gravity = [...]` |
| `fixedTimestep` | `1 / 60` | Seconds per step |
| `maxSubsteps` | `4` | Steps per frame before the backlog is dropped |
| `interpolate` | `true` | Interpolate meshes between steps |
| `timeScale` | `1` | Slow motion or fast forward |
| `paused` | `false` | Paused worlds keep their meshes but do not step |
| `substeps` | `8` | Equal pieces each step is split into; more is stiffer stacks and joints. `iterations` (default 2) are the solver passes in each. `physics.substeps` reads and sets it later (`solverIterations` is its old name); `body.additionalSolverIterations` (default 0) adds passes for that body's island alone |
| `contactFilter` | none | `(a, b) => boolean \| 'noForces'` per candidate pair |
| `name` | `'physics'` | Plugin name, for more than one world per engine |

`physics.addBody(mesh | null, options)`: `type` (`'dynamic'`, `'fixed'`, `'kinematicPosition'`, `'kinematicVelocity'`), `position`, `rotation` (quaternion; both default to the mesh), `colliders` (one or an array; `[]` for none), `linearVelocity`, `angularVelocity`, `linearDamping`, `angularDamping`, `gravityScale`, `ccd`, `canSleep`, `sleeping`, `lockRotations`, `lockTranslations`, `enabledRotations`, `enabledTranslations`, `additionalMass`, `dominance`, `follow`, `userData`.

Colliders: `shape` is `'box'` (`halfExtents`), `'sphere'` (`radius`), `'capsule'` (also `axis`, or `a`, `b` and `radius`), `'tetrahedron'` (`a`, `b`, `c`, `d`), `'cylinder'` and `'cone'` (`halfHeight`, `radius`, Y axis; `borderRadius`, default 0, rounds the edges), `'convexHull'` (`geometry` or `points`), `'trimesh'` (`geometry` or `vertices` and `indices`; `fixInternalEdges: true` lets a ball cross shared edges without catching), `'heightfield'` (`rows`, `columns`, `(rows + 1) * (columns + 1)` column-major `heights`, `scale` as the total size, centered on the body; `fixInternalEdges: true` as for a trimesh), `'compound'` (`parts`), `'convexDecomposition'` (the result of `convexDecomposition` from the decomposition entry, as `parts`), `'voxels'` (`cells`, an `Int32Array` of x, y, z cell coordinates, and `size`, one cell's size, default `[1, 1, 1]`), `'halfSpace'` (`normal`, out of the solid, default up), `'segment'`, `'triangle'` and `'polyline'` (surfaces with no mass). Plus `offset`, `rotation`, `friction`, `restitution`, `frictionCombine` and `restitutionCombine` (`'average'`, `'min'`, `'multiply'`, `'max'`), `density` or `mass`, `massless` (adds no mass or inertia and skips working them out, for the static pieces of a fixed body), `sensor`, `collisionGroups`, `solverGroups`, `events`, `enabled`.

Joints, `physics.addJoint(bodyA, bodyB, options)`: `type` `'fixed'` (`frameA`, `frameB` rotations), `'spherical'`, `'revolute'` or `'prismatic'` (`axis`, or `frameA` and `frameB` together; `limits`, `motor`), `'rope'` (`length`), `'spring'` (`restLength`, `stiffness`, `damping` default 0) or `'generic'` (below). All take `anchorA` and `anchorB` in each body's local frame and `contactsEnabled`. Motors take `targetVelocity`, `targetPosition`, `stiffness`, `damping` and `model` (`'acceleration'` or `'force'`).

A revolute or prismatic joint with frames turns or slides along the x axis of each frame. Line the frames up at rest and the rest pose reads 0, so `limits` count from it whatever the bodies' own rotations.

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

A force at a point pushes the body and turns it by the arm from its centre of mass; `resetTorques` clears the turning and keeps the push, `resetForces` clears both. `enabledTranslations` and `enabledRotations` are `[x, y, z]` booleans, a `false` holding that world axis still, and can be read and set after the body is made.

```ts
import { Physics } from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null, { gravity: [0, 0, 0] });
const ball = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1, mass: 2 } });
ball.applyImpulseAtPoint([4, 0, 0], [0, 1, 0]); // travels at 2 m/s and spins at -5 rad/s about z
ball.enabledTranslations = [true, false, true]; // it can no longer rise or fall
ball.addForceAtPoint([0, 0, 2], [1, 0, 0]);
physics.step();
ball.resetTorques(); // the force keeps pushing, nothing turns it any more
console.log(ball.linearVelocity, ball.angularVelocity, ball.enabledTranslations);
```

A `'generic'` joint picks its six degrees of freedom, named `linX`, `linY`, `linZ`, `angX`, `angY` and `angZ` along and about the axes of its frame on body A: `locked` lists axes that do not move, `limits` gives an axis a `[min, max]`, `motors` gives one a motor, and any other axis is free. `frameA` and `frameB` turn the joint's frame on each body (default identity). Positions are measured from frame A to frame B. `joint.setAxisLimits(dof, min, max)` and `joint.setAxisMotor(dof, motor)` change them later.

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

`joint.setRotationMotor(rotation, {stiffness, damping, model, maxForce, targetVelocity})` turns body B toward a rotation in body A's frame, on a spherical joint. With `model: 'force'`, a body of inertia I about the joint moves like a spring of frequency w and damping ratio z for `stiffness` I w² and `damping` 2 z I w; `maxForce` caps the torque in N m, on every motor; `targetVelocity` is the target's own spin. It moves the joint's frame on body A onto the target, because the solver cannot tell rotations apart near half a turn by their vector part.

Character controller options (a sphere, box, capsule, cylinder or cone collider on a `kinematicPosition` body): `offset` (0.01), `up`, `maxSlopeClimbAngle` (45 degrees), `minSlopeSlideAngle` (30 degrees), `autostep` (`{maxHeight: 0.3, minWidth: 0.2}` or `false`), `snapToGround` (0.2 or `false`), `slide`, `applyImpulsesToDynamicBodies`, `characterMass`. `offset`, `snapToGround` and the autostep's `maxHeight` and `minWidth` take metres or `{relative: share}` of the character's height along `up` (Rapier's `CharacterLength`); `normalNudgeFactor` (default 0.0001 m) pushes a sliding character off what it slides along so it does not catch. A move returns `{movement, grounded, collisions, slidingDownSlope}`, and the controller reads back Rapier's outputs: `isSlidingDownSlope`, `computedMovement()`, `computedGrounded()`, `numComputedCollisions()` and `computedCollision(i)` (`{collider, point, normal, translationApplied, translationRemaining}`). With `autostep.includeDynamicBodies` a dynamic body is a step it climbs.

Queries take `maxDistance`, `solid`, `groups`, `exclude` (a body), `excludeSensors`, `excludeFixed`, `excludeKinematic`, `excludeDynamic` and `predicate(body, collider)`. Ray and shape-cast distances are along the normalized direction. A query with no `groups` applies no group test at all, as Rapier's query filter does, so it sees every collider, even one whose own filter is 0; naming `groups` applies them both ways. Queries see the world as of the last step.

## The solver

What the own collision kernel holds against Rapier 3D, row by row (the capability list this solver was built to match), is in [docs/physics-collision-parity.md](../../docs/physics-collision-parity.md).

`@margoengine/physics` runs on Margo's own solver, a Rust kernel compiled to WebAssembly and shipped inside the package as a deflated blueprint in its JavaScript, so you need no toolchain, no peer install and no extra file. It holds the kernel's world, its memory, bodies with colliders that move under forces, contacts, joints, and islands that sleep.

```ts
import {KernelWorld, loadKernel} from 'margoengine/physics';

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
import {KernelWorld, loadKernel} from 'margoengine/physics';

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
import {KernelWorld, loadKernel} from 'margoengine/physics';

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

`Physics` is the world on top of the kernel: a fixed step with an accumulator and interpolation, bodies and colliders with optional meshes, joints, queries and events. `Physics.load()` needs no peer; a mesh is optional, and an engine moves its meshes with the same fixed step and interpolation.

```ts
import {Physics} from 'margoengine/physics';

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

It holds `box`, `sphere`, `capsule`, `convexHull`, `trimesh`, `heightfield`, `compound` and `voxels` colliders, bodies of every kind, forces, impulses, velocities, damping, locks, kinematic targets, gravity, sleeping and the `beforestep` and `afterstep` events. Bodies collide, with friction, restitution and the four combine rules, and `physics.touching(a, b)` and `physics.contactPoints(body)` read the contacts of the last step, walking only the asking body's pairs: `touching` allocates nothing, and a call costs that body's contacts, not the world's. Contact and intersection events, sensors, `collisionGroups`, `solverGroups`, `contactFilter`, `dominance` and `enabled` on bodies and colliders work, with the same names. `body.setType`, `setAdditionalMass` (with inertia of its own), `setMassProperties`, `collider.setDensity` and `additionalSolverIterations` work, . A call that needs what is still to come throws a `MargoError` with code `unsupported` naming what it waits for: the other shapes and `addModel` with the shapes and queries batch, `follow` and character controllers, and `debugRender`. `body.sleep()` and impulses take effect at the next step.

`raycast` and `raycastAll` work on every shape, with the names and options (`maxDistance`, `solid`, `groups`, `exclude`, `excludeSensors`, `excludeFixed`, `excludeKinematic`, `excludeDynamic`, `predicate`), plus Rapier's flags the root does not name: `excludeCollider`, `excludeSolids`, `onlyDynamic`, `onlyKinematic` and `onlyFixed`. `raycastAll` lists one hit a collider, nearest first, and `stop` ends the list early. Rays see the poses of the last step, as Rapier's do. A ray that starts inside a solid shape hits at distance 0 with a zero normal; with `solid: false` it hits where it leaves, the normal facing the ray.

```ts
import {Physics} from 'margoengine/physics';

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

`shapeCast`, `projectPoint`, `intersectPoint` and `intersectShape` work on every shape, with the names and the same filter options. The query shape is any convex one with its size given: `sphere`, `box`, `capsule`, `cylinder`, `cone`, `segment`, `triangle` or `convexHull`, the box and hull with their `borderRadius`. A `compound` (or a decomposed `convexDecomposition`) of those is a query shape too: it is cast and tested piece by piece. A `trimesh`, `heightfield` or `voxels` is a query shape as well: its triangles or cells are cast and tested one by one (a mesh is built in the world once for the options object you pass, so keep and reuse it). A `halfSpace` is a query shape too (the plane at the shape's position, turned by its rotation, and everything behind it): a cast stops when the plane meets a collider, and a start inside one is a hit at distance 0. `shapeCast` takes Rapier's cast options: `maxDistance` (default unbounded), `targetDistance` (stop this far short of touching, default 0), `stopAtPenetration` (default true: a cast that starts in contact hits at distance 0; false: one that starts in contact and moves out of it goes on) and `computeImpactGeometryOnPenetration` (default true: such a hit gets its normal and points; false leaves them zero). A hit gives the point and outward normal on the collider hit, and `queryPoint` and `queryNormal` on the cast shape. `projectPoint` takes `solid` (default true: a point inside a shape projects to itself, `inside` true, distance 0; false: to the nearest point of its surface). A trimesh or height field never holds a point.

```ts
import {Physics} from 'margoengine/physics';

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

Two colliders can be asked about directly, whether or not their bodies touch: `physics.contactPair(a, b, prediction = 0)` gives the contact manifolds within `prediction` metres (normal from `a` to `b`, and up to four points with the nearest point on each collider and their separation), `physics.intersectionPair(a, b)` whether they overlap, and `physics.colliderDistance(a, b)` how far apart they are with the nearest point on each, 0 when they overlap. A compound gives a manifold for each pair of children, a mesh or height field one for each triangle near the other collider (with the triangle's own normal: `fixInternalEdges` smooths only the world's contacts). `collider.aabb()` is a collider's tight box at its last step's pose (with its contact skin), `collider.sweptAabb(nextPosition, nextRotation)` the box that holds it now and at another world pose (Rapier's `compute_swept_aabb`), `collider.collisionAabb(prediction)` that box grown by the prediction distance (`compute_collision_aabb`), and `physics.intersectAabb(min, max)` the bodies whose colliders' boxes meet a box.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null, {gravity: [0, 0, 0]});
const ball = physics.addBody(null, {type: 'fixed', colliders: {shape: 'sphere', radius: 1}}).colliders[0];
const box = physics.addBody(null, {type: 'fixed', position: [3, 0, 0], colliders: {shape: 'box', halfExtents: [0.5, 1, 1]}}).colliders[0];
physics.step();
const {distance, pointA, pointB} = physics.colliderDistance(ball, box)!;
console.log(distance.toFixed(2), pointA[0].toFixed(1), pointB[0].toFixed(1)); // '1.50' '1.0' '2.5'
console.log(physics.contactPair(ball, box).length, physics.contactPair(ball, box, 2)[0].points[0].separation.toFixed(2)); // 0 '1.50'
console.log(physics.intersectionPair(ball, box), box.aabb().min); // false [2.5, -1, -1]
physics.dispose();
```

A query can also be limited to one collider, : `physics.raycastCollider(collider, origin, direction, {maxDistance, solid})`, `projectPointOnCollider(collider, point, {solid})`, `colliderContainsPoint(collider, point)`, `castShapeAtCollider(collider, shape, position, rotation, direction, options)` and `colliderIntersectsShape(collider, shape, position, rotation)`, with what the world's queries take and give. A query reads the poses as they are, so a pose set by hand (`body.setPosition`) is seen at once, with no query pipeline to update.

`ccd: true` on `addBody`, or `body.ccd = true`, turns on continuous collision for a body (default off): after each step a dynamic body that moved further than its thinnest piece is thick is swept from where the step began to where it ended and put back to its first touch, its velocity kept, so a fast thin body cannot pass a wall, a mesh or a height field. A slow body moves exactly as it would without it. `body.ccdActive` is true when the last step's sweep checked the body.

```ts
import {Physics} from 'margoengine/physics';

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

`setType` keeps the pose, colliders and joints: a body made fixed stops, and its touches with other fixed bodies end; one made `kinematicPosition` holds its pose until given a target; a dynamic or kinematic body keeps its velocity. With `wakeUp` (default true) a body made dynamic or kinematic wakes now; a sleeper otherwise, or one made fixed, reads asleep until the next step, which wakes it and what it touches whatever `wakeUp` said (measured). A kinematic body still for the sleep window reads asleep, as on Rapier, and a target wakes it. `setAdditionalMass(mass, inertia)` puts the mass at the centre of mass the body has now, so alone it leaves the inertia as it is, and replaces an earlier call, `setMassProperties` and the `additionalMass` option, which spreads its mass as the colliders are. `setMassProperties` sets the colliders' density to 0, and colliders added later add their own mass. `additionalSolverIterations` (any whole number from 0 to 4294967295, Rapier's 32 bits, ) gives the body's island that many passes more: it runs as a world of that many passes would, bit for bit, and the other islands are left alone.

```ts
import {Physics} from 'margoengine/physics';

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

A `trimesh` takes `vertices` (flat x, y, z numbers) and `indices` (three a triangle, counter-clockwise seen from its front), or `geometry`, or the body's mesh. It is a surface: both sides collide, and it adds no mass, so it belongs on fixed and kinematic bodies or with `setMassProperties`. Each triangle a shape touches holds its own contact normal, so a box in a corner keeps the floor and the wall. `fixInternalEdges: true` keeps contacts on the seams between triangles to the normals the surface allows, so a ball or a box slides across a flat run of triangles without catching on their inner edges; it is off by default, as in Rapier. `KernelWorld.addTrimesh(vertices, indices, {fixInternalEdges})` and `trianglesAcross(vertices, indices)` are the kernel's view of the same.

```js
import {Physics} from 'margoengine/physics';

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

A `trimesh` can be cleaned before it is built, each step off by default: `mergeDuplicateVertices` joins vertices at one position, `deleteDegenerateTriangles` drops triangles with a repeated vertex or no area, `deleteDuplicateTriangles` drops a triangle another repeats, whatever its winding, and `deleteBadTopologyTriangles` drops triangles that would make an edge belong to more than two (later ones first), in that order; a mesh that loses every triangle is refused. `cleanTrimesh(vertices, indices, options)` from this entry runs the same steps for you to see. `oriented: true` says the mesh is a closed surface, so `projectPoint`, `intersectPoint` and a solid ray from inside treat a point inside it as inside (by the parity of the surface crossings of a ray from the point); contacts are unchanged. A `convexHull` also takes a mesh, `vertices` and `indices`, and is the hull of the vertices the triangles use, as Rapier's `convexMesh`.

A `heightfield` takes its options, laid out so: `rows` cells along z and `columns` along x, `(rows + 1) * (columns + 1)` `heights` column major (row r, column c is `heights[r + (rows + 1) * c]`), and `scale`, the whole field's width, height factor and depth, centred on the body. Each cell is two triangles split along the diagonal from row r + 1, column c to row r, column c + 1, the split Rapier makes; a test casts 300 rays at Rapier's field and finds the own field's surface within 2.2e-6 m of it. `fixInternalEdges` works as on a `trimesh` (off by default, as in Rapier) and the root entry takes it too (`cellStatus` below is the own solver's only). Like a trimesh it is a surface with no mass. The kernel keeps only the grid's points, 12 bytes each, and builds no tree, so a field of 500,000 cells is ready in milliseconds; `KernelWorld.addHeightfield(rows, columns, heights, scale, {fixInternalEdges})` is the kernel's view of it.

```js
import {Physics} from 'margoengine/physics';

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

A field's cells can be given a status, as Rapier's Rust `HeightFieldCellStatus` does (its JavaScript build cannot): `cellStatus`, one number a cell with row r of column c at `r + rows * c`, adds up `HeightfieldCell.zigzag` (1, split the cell along its other diagonal, from row r, column c to row r + 1, column c + 1), `leftRemoved` (2, take away the triangle on the cell's lower x) and `rightRemoved` (4, the one on its higher x; `removed` is both). A removed triangle is a hole: nothing rests on it, no ray hits it, and the triangle beside it ends in an open edge. Rapier's docs do not say which triangle is left or right, or which diagonal a Z pattern is; these are the definitions here. `collider.cellStatus(row, column)`, `cellStatuses()` and `setCellStatus(row, column, status)` read and change them in place, and what rests on a changed cell wakes.

```js
import {HeightfieldCell, Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
const field = physics.addBody(null, {
  type: 'fixed',
  colliders: {shape: 'heightfield', rows: 4, columns: 4, heights: new Array(25).fill(0), scale: [4, 1, 4]},
});
physics.addBody(null, {type: 'fixed', position: [0, -3.5, 0], colliders: {shape: 'box', halfExtents: [10, 0.5, 10]}});
const ball = physics.addBody(null, {position: [0.5, 1, 0.5], colliders: {shape: 'sphere', radius: 0.2}});
for (let i = 0; i < 90; i++) physics.step();
console.log(ball.position[1].toFixed(2)); // 0.20: on the field
field.colliders[0].setCellStatus(2, 2, HeightfieldCell.removed); // a hole under the ball
for (let i = 0; i < 90; i++) physics.step();
console.log(ball.position[1].toFixed(2)); // -2.80: it fell through, onto the floor below
```

More ways to say a shape, each as Rapier has them. A `capsule` takes `axis: 'x' | 'y' | 'z'` (default `'y'`), or two end points and a radius, `{shape: 'capsule', a, b, radius}`, as `capsule_from_endpoints`. A `tetrahedron` takes `a`, `b`, `c`, `d` (and a `borderRadius`) and has the mass of its volume. A collider resizes in place with `setRadius(radius)`, `setHalfHeight(halfHeight)` and `setHalfExtents(halfExtents)`; its place and turn stay and a dynamic body's mass follows. A closed `trimesh` wound outwards takes `mass` or `density` (Rapier gives a mesh none): the mass, centre and inertia are those of the volume it encloses, and an open or inside-out mesh is refused with what to fix. `connectedComponents: true` and `halfEdgeTopology: true` on a `trimesh` keep what `collider.connectedComponents()` and `collider.halfEdgeTopology()` read (`meshConnectedComponents(indices)` and `meshHalfEdges(indices)` give the same for any mesh). `voxelsFromPoints(points, size)` and `voxelizedMesh(vertices, indices, size, 'surface' | 'filled')` give the cells for a `voxels` collider, and `convertMesh(vertices, indices, 'trimesh' | 'convexHull' | 'aabb' | 'obb')` picks the collider options for a mesh (`borderRadius` rounds the hull; a decomposition is `convexDecomposition(mesh, {borderRadius})`).

```js
import {Physics, convertMesh, voxelsFromPoints} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
// A closed unit-cube mesh, wound outwards, weighs what a metre cube of density 500 does.
const vertices = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
const crate = physics.addBody(null, {colliders: {shape: 'trimesh', vertices, indices, density: 500}});
console.log(crate.mass); // 500
const lying = physics.addBody(null, {colliders: {shape: 'capsule', axis: 'x', halfHeight: 1, radius: 0.25}});
lying.colliders[0].setRadius(0.5);
const cells = voxelsFromPoints([0.2, 0.2, 0.2, 1.4, 0.2, 0.2], 1); // two cells
physics.addBody(null, {type: 'fixed', colliders: {shape: 'voxels', cells: cells.cells, size: cells.size}});
console.log(convertMesh(vertices, indices, 'obb').halfExtents); // [0.5, 0.5, 0.5] in some order
```

A `compound` takes `parts`: boxes, spheres, capsules, cylinders, cones and convex hulls (a box or hull with a `borderRadius` too), and a `trimesh`, `heightfield` or `voxels` part as well (a surface, for a fixed body's scenery: a voxel part weighs nothing here; Rapier 0.21's JavaScript aborts when a compound has a triangle mesh part, and builds one with a height field or voxel part, which this solver matches). A mesh part meets the convex colliders and the parts of other compounds, and no mesh at all. A `halfSpace` is a part too (the plane through its offset): an endless floor beside a box. each with its own `offset` and `rotation` in the collider's frame, never fitted to the mesh. It is one collider, as in Rapier: one handle, one pair and one set of events against each other collider, and one `density` (or `mass`, spread by volume) for every part. Each part that touches keeps its own contact points and warm start, and parts are culled by their own boxes, so the gaps between them are empty. Its mass, centre and inertia match Rapier's for the same parts (a test holds them to 1e-5) and are the same bits as the parts added as colliders of their own. `boundingRadius` is null, as on the root entry. `KernelWorld.addCompound(body, parts, options)` is the kernel's view of it.

```js
import {Physics} from 'margoengine/physics';

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

A `voxels` collider takes `cells` (an `Int32Array` of x, y, z cell numbers, three per cell) and `size` (one cell, default `[1, 1, 1]`); cell (i, j, k) spans `[i, i + 1]` times the size along x, and so on. `setVoxel(x, y, z, filled)` edits it in place, keeping the contacts of every other cell, and a cell outside the grid grows it. Two grids that meet call `a.combineVoxelStates(b, sx, sy, sz)` once, `sx`, `sy`, `sz` the cells `b` is shifted by, and `a.propagateVoxelChange(b, x, y, z, sx, sy, sz)` after an edit on their border, so a body crosses the seam without catching; left uncoupled, the border is the side of a step and a sliding box catches on it, as on Rapier. A grid has the mass of its cells, so it can be a dynamic body; it meets every shape but triangle meshes and heightfields, which it falls through, as Rapier's does. Inside one grid a body slides across the cells without catching on the faces between them: a contact normal may lean only toward exposed faces. Its mass follows an edit at once (Rapier's at the next step). The kernel keeps one byte a cell over the box of the cells, so a sparse grid costs its box: split a large world into chunks. `KernelWorld.addVoxels(cells, size)` is the kernel's view of it.

```js
import {Physics} from 'margoengine/physics';

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

A `convexHull` takes `points` (flat x, y, z numbers), or `geometry`, or the body's mesh when it has neither, scaled with the mesh. The solver builds it by Quickhull: points inside, repeats and points within 2.5e-5 of the hull's size of a face are dropped, triangles in one plane become one face of up to 256 corners, and colliders built from the same points share one hull. `convexHull(points)` returns the `vertices` and `faces` it builds, for drawing or checking; it throws a `RangeError` naming the fix for fewer than four points or points that span no volume.

```ts
import {Physics, convexHull} from 'margoengine/physics';

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

A `segment` (`a`, `b`), a `triangle` (`a`, `b`, `c`) and a `polyline` (`vertices`, optional `indices`) are surfaces in the collider's frame with no volume, so no mass or density: they belong on fixed bodies or with `setMassProperties`. A triangle collides on both sides, and `borderRadius` rounds it by that much all round (Rapier's `roundTriangle`).

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', colliders: {shape: 'polyline', vertices: [-2, 2, 0, 0, 0, 0, 2, 2, 0]}}); // a V
const ball = physics.addBody(null, {position: [-1, 3, 0], colliders: {shape: 'sphere', radius: 0.2}, linearDamping: 0.5});
for (let i = 0; i < 600; i++) physics.step();
console.log(ball.position[0].toFixed(1), ball.position[1].toFixed(2)); // '0.0' '0.28': in the corner
physics.dispose();
```

A `halfSpace` (`normal`, default up; the collider's origin is a point on the plane) is everything behind the plane, solid and with no volume, so it belongs on a fixed body: an endless floor. It meets every convex shape, and rays, casts, point projection and overlaps use the plane's closed forms. A mesh, height field, voxel grid or another half space does not collide with it. Contacts use a box laid under the other shape for each pair, so they cost what a box's do.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', colliders: {shape: 'halfSpace', normal: [0, 1, 0]}});
const ball = physics.addBody(null, {position: [0, 3, 0], colliders: {shape: 'sphere', radius: 0.4}});
for (let i = 0; i < 240; i++) physics.step();
console.log(ball.position[1].toFixed(2)); // '0.40': resting on the plane
physics.dispose();
```

A `box` and a `convexHull` take `borderRadius` (default 0) too: the shape is every point within the border of the box or hull, so edges and corners are rounded and the box rests a border above where a sharp one does. A round box or hull weighs its core, as in Rapier; the border is not in `halfExtents`. It works in contacts, rays, point projection, shape casts and CCD; a box or convexHull part of a compound takes `borderRadius` too, and so does a query shape.

A `cylinder` and a `cone` stand along their local Y, `halfHeight` each way, a cone's apex at the top. `borderRadius` rounds every edge with a border outside `radius` and `halfHeight`, and `collider.borderRadius()` reads it back. A round shape weighs its border too, where Rapier weighs only its core, so give `mass` to match a Rapier scene's weights. A cap or base on a floor holds a full manifold, so the shape stands; rays, `shapeCast` and point queries meet the exact surface.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [20, 0.5, 20]}});
const can = physics.addBody(null, {position: [0, 2, 0], colliders: {shape: 'cylinder', radius: 0.3, halfHeight: 0.5, borderRadius: 0.05}});
const cone = physics.addBody(null, {position: [2, 2, 0], colliders: {shape: 'cone', radius: 0.4, halfHeight: 0.3}});
for (let i = 0; i < 180; i++) physics.step();
console.log(can.position[1].toFixed(2), cone.position[1].toFixed(2)); // 0.55 0.30: on its rounded cap, on its base
physics.dispose();
```

After each step a pair that began or stopped touching fires `contactstart` or `contactend`, or `intersectionstart` or `intersectionend` when either collider is a sensor, with both bodies, meshes and colliders. A sensor sees overlaps and pushes nothing, and it sees kinematic and fixed bodies too. Two fixed bodies never meet, sensor or not. A collider stays quiet with `events: false` when the other side has it too. A pair of sleepers says nothing. A collider or body removed while it touches ends the contact at once, and the end event, `removed: true` (Rapier's `CollisionEventFlags::REMOVED`), is delivered at the end of the next step, still naming both colliders. `collisionGroups` keeps a pair apart; `solverGroups` lets it be seen and fire events without being solved. Both take a packed `collisionGroups(memberships, filter)` number (16 + 16 bits, as Rapier's JavaScript build packs them) or `interactionGroups(memberships, filter, testMode)`, 32 bits wide as Rapier's Rust `InteractionGroups` is: masks or lists of group indices 0 to 31, tested by `'and'` (each side's memberships share a bit with the other's filter, the default) or `'or'` (either way; used only when both colliders ask for it, and a mixed pair tests by `and`). A collider left at its default is in every group. `collider.interactionGroups()` and `solverInteractionGroups()` read them back, and scene queries take either form as `groups`. `contactFilter(a, b)` runs inside the step for each candidate pair of bodies: it may read the world and must not change it, so a step run from it throws, and false lets the pair pass and keeps its sensor events quiet. A body of higher `dominance` is a wall to a dynamic body of lower dominance, in contacts only, and floors still hold it. `body.enabled = false` takes a body out of the world: it keeps its pose and speed, nothing wakes it, its touches end and what rested on it falls, and its joints rest until it comes back, awake. `collider.setEnabled(false)` does the same for one collider, which keeps its mass.

```ts
import {Physics, collisionGroups} from 'margoengine/physics';

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

A `trimesh` with `deformable: true` (Rapier's `TriMeshFlags.DEFORMABLE`) keeps its vertices movable: `collider.setVertices(positions)` takes one packed x, y, z a vertex, in the collider's frame, and moves the surface as a kinematic body goes to its target. The next step makes its contacts against the surface where it is, with each vertex moving at its velocity (its displacement over the step, or the `velocities` you pass), so friction carries a crate lying on a sliding sheet, bounce and the push count the surface's speed, and a surface that moves through a body faster than its radius a step still catches it (contacts and the broad phase reach as far as the farthest vertex goes, and the contact solver closes the gap as the surface comes on). The end of that step lands the mesh on the positions with one refit of its tree (every node touched once, no rebuild), and what rests on it wakes. The speed lasts that one step: a surface not set again is still. Call it between steps, as often as every step. `vertices()`, rays and queries see the new positions once the step has run; `setVertices(positions, {now: true})` moves the mesh at once with no velocity (a teleport, for building a mesh up between steps). A mesh that is not `deformable` throws a `state` error from `setVertices`. A surface moves in a straight line over the step, with the mean of a triangle's three vertex velocities as its speed.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
const vertices = [-2, 0, -2, 2, 0, -2, 0, 0, 2];
const floor = physics.addBody(null, {type: 'fixed', colliders: {shape: 'trimesh', vertices, indices: [0, 2, 1], deformable: true}});
const ball = physics.addBody(null, {position: [0, 1, 0], colliders: {shape: 'sphere', radius: 0.25}});
for (let step = 0; step < 120; step++) {
  const lift = 0.002 * step;
  floor.colliders[0].setVertices(vertices.map((v, i) => (i % 3 === 1 ? lift : v)));
  physics.step();
}
for (let step = 0; step < 60; step++) physics.step();
console.log(ball.position[1] > 0.4);
```

`physics.softContacts({from, to, radius, margin, groups}, k, options)` answers a soft solver's question for a batch of particles at once, one call a step: for each particle of radius `radius` that moves from its position in `from` to its position in `to` (packed x, y, z), up to `k` colliders (at most `physics.kernel.probeDepth`, 4), the deepest first, each as a plane with what a solver needs to hold it: `point` on the collider's surface, `normal` out of it, `depth` (how far the end of the move is inside the radius: push out along `normal` by that much when positive; negative is a gap still open, listed when it is within `margin` past the radius, so one call a step serves every substep), `velocity` of the surface there (the body's linear velocity plus its spin about its centre, and the vertices' of a deformable mesh from `setVertices`), `t` (the fraction of the move at which the particle first touches: it is swept, so a fast one never passes through a thin shape) and `started`. Every shape is met; sensors and disabled colliders never are; `groups` (one word for all in `options.groups`, or one each in `views.groups`) and the query flags are honoured; `options.exclude` leaves a body out (the soft body's own rigid frame). `options.dt` (the step's seconds) sweeps each particle against every collider along that collider's own linear and angular motion over the step, in the collider's frame (conservative advancement, Mirtich 1996), so a fast bat or a spinning paddle cannot pass a particle: the contact's point and normal are then in the collider's pose at the start of the step, and the plane goes on at `velocity`. A particle that starts touching a surface or inside its radius meets the surface nearest the start, on the side it came from (a thin wall's near face), at time 0. The answer is typed arrays with `k` slots a particle (`collider` 0xffffffff for an empty slot, `physics.colliderOf(row)` for the collider), up to 1,024 particles a call, more in chunks. `physics.kernel.probeParticles(from, to, radius)` is the one-contact form. Cloth meeting itself is in the soft kernel: `soft-kernel/src/collide.rs`, which finds vertex against triangle and edge against edge within a thickness (`margoengine_physics_kernel_common::cloth`) and pushes them apart as position constraints each substep; JavaScript gives it the triangles, a thickness and Coulomb's friction coefficient between the cloth surfaces (`soft_collide_reserve`, `soft_collide_triangles`, `soft_collide_set(triangles, thickness, friction)`): the tangential motion two touching points make against each other in a substep is cut by up to that coefficient times the push that separated them, so a cloth on a tilted cloth holds below the friction angle and slides above it.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [5, 0.5, 5]}});
physics.step();
// One particle of radius 0.1 falls 20 m in one step: it is stopped at the floor, not carried through it.
const contacts = physics.softContacts({from: [0, 10, 0], to: [0, -10, 0], radius: 0.1}, 2);
console.log(contacts.t[0], contacts.normal.slice(0, 3), contacts.depth[0], contacts.velocity.slice(0, 3));
```

A `contactFilter` may also answer `'noForces'`: the pair's contacts are found and its `contactstart` and `contactend` events fire, but nothing pushes (Rapier's `filterContactPair` answering with no solver flags). `false` still lets the pair pass through with no events, and `true` solves it.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null, {contactFilter: (a, b) => (a.userData === 'ghost' || b.userData === 'ghost' ? 'noForces' : true)});
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [5, 0.5, 5]}});
const ghost = physics.addBody(null, {position: [0, 2, 0], userData: 'ghost', colliders: {shape: 'sphere', radius: 0.5}});
physics.on('contactstart', () => console.log('touched, no force'));
for (let i = 0; i < 120; i++) physics.step(); // the ghost sinks through the floor and logs once
console.log(ghost.position[1] < -1);
```

A `contactModifier` in the `Physics` options is a contact modification hook: it is called, each step, for every touching pair that has a collider with `modifyContacts: true`, after the pair's friction and bounce are set and before it is solved. It may change `contact.friction`, `contact.restitution` and `contact.normal` (world space, from `contact.first` to `contact.second`), call `contact.clear()` to drop the pair's contacts for the step, set `contact.surfaceVelocity` (world space, a conveyor: friction brings the sliding of the second collider's surface against the first's to it, for this step), or `contact.oneWay(platform, direction, angle)` to keep only the contacts whose normal, taken from the platform to the other collider, is within `angle` (a quarter turn by default) of `direction`. The object is reused: do not keep it. Rapier's JavaScript has no such hook, so the root entry refuses `modifyContacts`. `contactFilter` (above) remains the pair filter for contacts and intersections.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null, {
  // Contacts count only from above the platform: a ball rises through it and lands on it.
  contactModifier: (contact) => contact.oneWay(contact.first.body.type === 'fixed' ? contact.first : contact.second, [0, 1, 0]),
});
physics.addBody(null, {type: 'fixed', position: [0, 3, 0], colliders: {shape: 'box', halfExtents: [3, 0.1, 3], modifyContacts: true}});
const ball = physics.addBody(null, {position: [0, 1, 0], linearVelocity: [0, 12, 0], colliders: {shape: 'sphere', radius: 0.3}});
for (let i = 0; i < 330; i++) physics.step();
console.log(ball.position[1].toFixed(2)); // '3.40': back down, resting on the top face
physics.dispose();
```

A collider can be edited after it is made: `collider.setTranslationWrtParent([x, y, z])` and `setRotationWrtParent([x, y, z, w])` move it in its body's frame, and `collider.setShape(options)` gives it another shape with its offset and rotation in the options (zero and none when left out). Friction, groups, events and hooks stay, what it touched ends and the body's mass is worked out again (from `mass` or `density` in the options when given, else the collider's own density). A compound cannot be made or changed this way.

`new Physics(engine, {predictionDistance})` and `physics.predictionDistance` (metres, default 0.04) are the prediction distance: how far apart two shapes may be and still have contacts made. A contact inside it is speculative: it keeps the shapes from sinking in and pushes nothing until they close. A larger value finds contacts earlier and keeps more pairs; setting it fits every box again at the next step. `contactSkin` on a collider (metres, default 0) is Rapier's contact skin: contacts are made and solved as if the shape were that much thicker, so a body rests a skin above what it lies on (two colliders' skins add up) and starts touching a skin away; `collider.setContactSkin(skin)` and `contactSkin()` change and read it. `softCcdPrediction` on a body (metres, default 0) is Rapier's soft CCD: its contacts reach that much further than the step's own motion, which the own solver always includes (a fast body meets a thin wall without it), so a value adds margin; `body.softCcdPrediction` reads and sets it.

A collider answers what Rapier's collider API does. `volume()`, `mass()` and `setMass(kg)` (which sets the density from the volume); `massProperties: {mass, centerOfMass, principalInertia, inertiaFrame}` as an option, or `setMassProperties(...)` and `clearMassProperties()`, give it a mass, centre and inertia of its own in place of its shape's, and the body's are worked out from them. `frictionCombineRule()` and `restitutionCombineRule()` with their setters (`'average'`, `'min'`, `'multiply'`, `'max'`, `'clampedSum'`, the sum from 0 to 1, or `'geometricMean'`, the square root of the product; two colliders with different rules use the stronger, in that order from `geometricMean` down to `average`), `borderRadius()` and `setBorderRadius()` (a box, hull, triangle, cylinder or cone), `translation()` and `rotation()` in the world, and `vertices()`, `indices()` and `heightfieldHeights()`, `heightfieldNRows()`, `heightfieldNCols()` and `heightfieldScale()` (heights as scaled, the scale `[width, 1, depth]`) read it back. `activeHooks` (`filterContactPairs`, `filterIntersectionPairs`, `modifyContacts`) as an option or `setActiveHooks(...)` says which hooks involve it: a pair is shown to `contactFilter` (or, with a sensor in it, to `intersectionFilter`) when either collider has the flag, and both flags are on by default. On the world: `contactPairsWith(collider)` and `intersectionPairsWith(collider)` list what it touches as of the last step, `contactShape(collider, shape, position, rotation, prediction)` gives the manifolds with a shape, `castColliderOnto(moving, target, direction)` and `castCollider(moving, direction)` cast a collider as it is, and `getColliders()` visits every collider. `contactPair` also gives the pair's friction and restitution and each point's `normalImpulse` and `tangentImpulse` (the solver's last substep, 0 for a contact the world does not hold), and a `contactforce` event the `totalForce` vector, `maxForceMagnitude` and `maxForceDirection`, `totalForceMagnitude` of the pair's contacts (the last substep's pushes scaled to the step's impulse). Ray hits and point projections carry `featureType` ('vertex', 'edge', 'face' or 'unknown') and `featureId`, worked out when read: a box's faces are `2 axis + (low side ? 1 : 0)`, its edges `4 axis + two bits`, its vertices three bits; a hull's faces, vertices and edges are its rows; a mesh's faces are triangle numbers; a height field's `2 cell + half`; other shapes are unknown.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null, {gravity: [0, 0, 0]});
const crate = physics.addBody(null, {colliders: {shape: 'box', halfExtents: [0.5, 0.5, 0.5], density: 800}}).colliders[0];
const wall = physics.addBody(null, {type: 'fixed', position: [3, 0, 0], colliders: {shape: 'box', halfExtents: [0.5, 2, 2]}}).colliders[0];
physics.step();
console.log(crate.volume(), crate.mass());                         // 1 800
const hit = physics.raycast([-5, 0.2, 0.3], [1, 0, 0])!;
console.log(hit.featureType, hit.featureId);                       // 'face' 1: the crate's -x face
console.log(physics.castColliderOnto(crate, wall, [1, 0, 0])!.distance.toFixed(2)); // '2.00'
physics.dispose();
```

`activeCollisionTypes` on a collider names the kinds of body pair it takes part in: any of `dynamicDynamic`, `dynamicKinematic`, `dynamicFixed` (the default three), `kinematicKinematic`, `kinematicFixed` and `fixedFixed`. A pair of colliders is made when both name its kind, so two kinematic bodies raise `contactstart` and `contactend` only when both colliders add `kinematicKinematic`, and a floor that leaves out `dynamicFixed` lets a body fall through. A sensor sees every kind. `collider.setActiveCollisionTypes(kinds)` and `activeCollisionTypes()` change and read it. `contactForceEvents` (default true, where Rapier's default is off) and `contactForceThreshold` (newtons, default 0) on a collider choose its contact-force events; a pair speaks when either side asks and its force passes the larger threshold, and `collider.setActiveEvents({collision, contactForce})` and `setContactForceEventThreshold(n)` change them.

`physics.on('contactforce', listener)` says how hard two colliders pressed on each other: after each step with a listener, once a pair, with `bodyA`, `bodyB`, `meshA`, `meshB`, `colliderA`, `colliderB`, `impulse` (the normal impulse of the whole step, N s) and `force` (that over the step's length, N). A box at rest on a floor reads its weight, and the impulses of a landing add up to what stops it. A pair of sleepers is not solved, so it says nothing. Only the own solver has this event.

```ts
import {Physics} from 'margoengine/physics';

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

`physics.addJoint(bodyA, bodyB, options)` holds `fixed`, `spherical`, `revolute`, `prismatic`, `rope` and `spring` joints, and `generic` joints, with `limits`, `motor`, `axis` or `frameA` and `frameB`, `locked`, `motors`, `contactsEnabled`, `joint.setLimits`, `setMotor`, `setRotationMotor`, `setAxisLimits`, `setAxisMotor`, `clearMotor`, `remove`, and the same errors. A joint keeps its two bodies from colliding unless `contactsEnabled` is true, and leaves with either body. A `generic` joint is the joint its locks make, bit for bit: all six are a `fixed` joint, the linear three a `spherical` one. An axis with one free turning axis reads its angle past a whole turn; with two or three free, each reads its part of the rotation vector from frame A to frame B. A limit or motor on a locked axis throws a `RangeError`, and `clearMotor` stops every axis's motor. A `rope` is slack inside its `length` and stops dead at it, and a `spring` is Hooke's law in implicit form, so any stiffness is stable, at the price of the decay implicit Euler brings: 1 / sqrt(1 + (w h)^2) a substep, about 23 percent of the amplitude in 10 s for a spring of 5 rad/s.

A joint that cannot be met stays calm rather than exact: a chain pulled straight between two walls and a little too short holds under 1 m/s, and an open joint closes at 3 m/s plus what the turning carries its anchors, so a body you move by hand comes back over several steps and does not jump past what is in the way. `docs/limits.md` gives what each limit costs. `world.step` and `physics.step` throw `MargoError` with code `failed` when a body goes past 1e15 in position or speed, which a true path can do: a bead free on a spinning rail flies out exponentially. The world keeps its last state and steps no more, so restore a snapshot or build it again with the joint limited.

```ts
import {Physics} from 'margoengine/physics';

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
import {Physics} from 'margoengine/physics';

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

A joint's limits are rigid up to their edge and give way past it as a contact does; `joint.setLimitSoftness(hertz, damping = 1)` lets one give way as a spring of its own instead (0 takes the contact's stiffness again). A soft limit pushes back at omega / (2 damping) times the depth, so under a steady load the give is the load's acceleration over that rate, and halving the frequency doubles it.

`joint.setRotationMotor(rotation, options)` works on a cone too, with the same options: a spring toward a rotation of `bodyB` in `bodyA`'s frame (swing and twist both), while the cone's limits keep acting and win where the target lies outside them. A cone keeps its frames for its own axis, so the target is stored apart from them, and it is a rotation of `bodyB` in `bodyA`'s frame as on a spherical joint, whatever the cone's frames are: each substep the turn left from the target to body B is taken as a rotation vector along the target's axes, the soft spring of Catto (2011, "Soft Constraints") drives it, and the same Muller et al. (2020) measure as the hinge reads it near half a turn. `clearMotor()` lets the cone go. A cone's twist motor and its rotation motor share the twist's gains, so use one of them. The spring of a rotation motor is weaker than the limit by design only when its stiffness stays well under the limit's own, which is the limb's mass times (2 pi 120 Hz) squared; a force-model motor stiffer than that pushes through a limit by the ratio of the two.

Every limit, a cone's and a hinge's, stops its axis dead at the edge and holds any load there. An axis that starts past its edge, or is held there by a floor, is pushed back as a contact pushes out of a depth, so a limb that cannot reach its cone comes to rest where it lies. That push has the strength of the limb's own mass: a very light hand under an arm stays where the arm leaves it.

`joint.setRotationMotor(rotation, options)` drives a `spherical` joint toward a rotation of `bodyB` in `bodyA`'s frame, and reads true near half a turn: the joint's frame on `bodyA` moves onto the target, so what is left to drive stays small. With `model: 'force'` a limb of inertia I about the joint moves like a spring of frequency w for `stiffness` I w^2 and `damping` 2 I w, `maxForce` caps the torque, and `targetVelocity` is the target's own spin, so a moving target is followed without lag.

```ts
import {Physics} from 'margoengine/physics';

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
import {Physics} from 'margoengine/physics';

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
import {KernelWorld, loadKernel} from 'margoengine/physics';

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

A concave mesh for a dynamic body goes through `convexDecomposition` from `margoengine/physics/decomposition`, its own entry, so a game that never decomposes never loads it. It takes a closed mesh (`vertices` and `indices`, or a geometry; equal positions are welded when the mesh is only closed after that, and one wound inside out is turned) and returns `{shape: 'convexDecomposition', parts, concavity}`, which is a collider on this entry and on the root one. It is the method of Wei, Liu, Ling and Su (ACM TOG 2022, CoACD): a part is cut by the axis plane a tree search over the next four cuts likes best, until each part's concavity, the larger of the widest gap between the part's surface and its hull's and 0.3 times the radius of a ball with the volume the hull adds, is under `concavity`, a share of the mesh's largest side (default 0.05); then neighbours that share a whole cut face merge while they stay under it. `maxConvexHulls` (default 64) caps the parts, cutting the least convex first; `borderRadius` (default 0) rounds every part, as Rapier's `round_convex_decomposition` (V-HACD's voxel terms `alpha`, `beta`, `resolution` and fill mode have no counterpart in a method that cuts the mesh itself); `planes` (20 per axis), `iterations` (500), `depth` (4) and `merge` (true) are the paper's settings; `seed` (0) makes a result repeat bit for bit; `timeLimit` (60,000 ms) stops it with a `timeout` `MargoError`, never a half-done answer. It is build-time work, seconds for a thousand triangles, so decompose once and keep the parts. `decompositionConcavity(mesh, parts)` scores any set of convex parts by the paper's measure, Rapier's included.

```ts
import {Physics} from 'margoengine/physics';
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

### Solver settings and speed caps

`physics.setSolver(options)` tunes the solver from the next step on, and `physics.solver` reads it. Contacts are soft constraints (Catto 2011): `contactHertz` is their stiffness as a frequency (default 120, and never above an eighth to a quarter of the substep rate), `contactDamping` their damping ratio (default 10), `contactMaxPush` the fastest a depth is pushed out in m/s (default 3) and `allowedPenetration` the depth left alone in metres (default 0.0002). Joints close `jointShare` of an error a substep where the solve is exact (default 1) and `jointLooseShare` where they meet in a branch or ring (default 0.2), at most `jointMaxPush` units a second (default 3). `warmStart` (0 to 1, default 1) is the share of each carried contact impulse kept at the start of a substep. The settings are part of a snapshot, a value out of range throws a `RangeError`, and a call changes nothing when it throws.

A body takes `maxLinearSpeed` (m/s) and `maxAngularSpeed` (rad/s), as options or properties; the step cuts a faster dynamic body to its cap and keeps its direction. The default is `Infinity`, no cap, and kinematic bodies are never cut.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null, {gravity: [0, 0, 0]});
physics.setSolver({contactHertz: 60, allowedPenetration: 0.001});
const body = physics.addBody(null, {colliders: {shape: 'sphere', radius: 0.5}, maxLinearSpeed: 5});
body.setLinearVelocity([30, 40, 0]);
physics.step();
console.log(Math.hypot(...body.linearVelocity).toFixed(2)); // '5.00'
physics.dispose();
```

`lengthUnit` (option and property, default 1) is Rapier's length unit: the number of your units to a metre-scale, 100 for a world in centimetres. The solver's tolerances (the contact reach `predictionDistance`, `allowedPenetration`, the push-out speeds `contactMaxPush` and `jointMaxPush`, and the sleep speed) are scaled by it, so a world built in centimetres with gravity `-981` plays out as the metre world does; give gravity, sizes and masses in the same unit yourself. `maxCcdSubsteps` (default 1) turns continuous collision off for the whole world when 0; the one pass the solver takes resolves a body's whole sweep, so 2 or more is the same as 1. `physics.timing` reads how long the phases of the last step took in milliseconds (`step`, then `begin`, `broad`, `narrow`, `islands`, `solver`, `ccd` and `events`, which add up to `step`); the clock is not part of the world, so a snapshot and the hash do not see it. `physics.forEachActiveBody(visit)` visits the bodies the last step worked on: awake dynamic bodies and moving kinematic ones, never sleepers or fixed bodies. `userData` rides on bodies and colliders (an option and a property), and an event hands the same objects back.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null, {gravity: [0, -981, 0], lengthUnit: 100});
physics.addBody(null, {type: 'fixed', position: [0, -50, 0], colliders: {shape: 'box', halfExtents: [2000, 50, 2000]}});
const crate = physics.addBody(null, {
  position: [0, 500, 0],
  userData: 'crate',
  colliders: {shape: 'box', halfExtents: [50, 50, 50], userData: 'lid'},
});
for (let i = 0; i < 60; i++) physics.step();
physics.forEachActiveBody((body) => console.log(body.userData, body.position[1].toFixed(0))); // 'crate' '50'
console.log(crate.colliders[0].userData, physics.timing.step < 1000); // 'lid' true
physics.dispose();
```

### PID controller

`PidController` drives a body toward a target pose. `linearCorrection(dt, body, target, targetVelocity?)` and `angularCorrection(dt, body, target, targetAngularVelocity?)` return the acceleration it asks for: `kp` times the error, plus `ki` times the error summed over time, plus `kd` times the speed error. `applyLinear` and `applyAngular` land it as an impulse of mass (or world inertia) times acceleration times `dt`, so a heavy body and a light one follow the same path. Call once a step with the step's length. `axes` masks the world axes it works on, `reset()` clears the integral, and gravity is not compensated: the integral takes it up. The angular error is twice the vector part of the short turn to the target, which is the angle in radians to 0.1 percent below 0.1 radian and a little under it beyond. Gains must be finite and at least 0; a step must be above 0.

```ts
import {PidController, Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
const body = physics.addBody(null, {colliders: {shape: 'sphere', radius: 0.25, density: 1000}});
const pid = new PidController({kp: 60, ki: 400, kd: 16});
for (let i = 0; i < 600; i++) {
  pid.applyLinear(1 / 60, body, [0, 2, 0]); // hold 2 m up against gravity
  physics.step();
}
console.log(body.position[1].toFixed(2)); // '2.00'
physics.dispose();
```

Each body can also take its own sleep limits: `body.sleepThreshold` (kinetic energy per unit of mass in J/kg, default the world's 0.0002) and `body.sleepTime` (seconds, default the world's 0.5), each cleared back to the world's with `Infinity`. An island sleeps when every body of it is still by its own limits.

### Breaking joints

A joint takes `breakForce` (newtons) and `breakTorque` (newton metres), or `joint.setBreakLimits(force, torque)`; the default is never. The load is what the joint's linear rows (force) or angular rows (torque) give in a substep over the substep's length, read at the last substep of a step, so a joint that holds a weight at rest reads that weight. A joint past a limit breaks: it solves nothing from then on, its two bodies may collide and both wake, and the world raises one `jointbreak` event with the joint and its bodies. `joint.broken` reads it, `joint.breakLimits` the limits, and `joint.repair()` puts it back at work. A limit must be above 0 or `Infinity`.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
const anchor = physics.addBody(null, {type: 'fixed'});
const weight = physics.addBody(null, {position: [0, -2, 0], colliders: {shape: 'sphere', radius: 0.25, mass: 10}});
const rope = physics.addJoint(anchor, weight, {type: 'spherical', anchorB: [0, 2, 0], breakForce: 50}); // 10 kg weighs 98 N
physics.on('jointbreak', ({joint}) => console.log('snapped', joint === rope));
for (let i = 0; i < 60; i++) physics.step();
console.log(rope.broken, weight.position[1] < -2); // true true
physics.dispose();
```

### More of the joint API

A joint reads and sets what it was made with. `userData` (an option, then a property) carries anything you want to find again; `enabled = false` takes a joint out of the solve and `true` puts it back, with its limits and motors as they were; `joint.force` and `joint.torque` are the force and couple, in newtons and newton metres in the world's axes, that the joint applied to `bodyB` in the last step, so a joint that holds a 10 kg weight reads 98.1 N up. `setAnchorA`, `setAnchorB` and `setFrames(frameA, frameB)` move a joint's anchors and turn its frames after creation, and `flip()` swaps its two bodies with their anchors and frames and mirrors the limits, motor targets and angle, so the joint holds the same pose from the other body; it flips a hinge, a slider, a ball, a fixed joint, a rope, a spring and a generic joint with one free turning axis, and refuses what does not mirror axis by axis (a cone, a rotation motor, a joint of a multibody, limits on two turning axes) with a `TypeError` that says so. `physics.getJoints()` and `physics.jointCount` list the world's joints.

Three more kinds. A `spring` takes `model: 'acceleration'`, which makes its stiffness and damping per kilogram, so a light body and a heavy one swing at the same frequency (the default `'force'` is newtons per metre, and a heavy body swings slowly on it). A `rope` takes a `motor`, a winch: its `targetVelocity` is the speed the anchors' distance changes at, so a negative one reels them in, up to the motor's `maxForce`. A `pinSlot` joint slides along one axis and turns about it, and holds the rest; `slideLimits`, `turnLimits`, `slideMotor` and `turnMotor` bound and drive the two.

A generic joint takes `coupled` axes, Rapier's `coupled_axes`: `coupled: ['linY', 'linZ']` with `limits: {linY: [0, 0.5]}` keeps the anchor within 0.5 m of the joint's X axis (a rod in a round hole), and `coupled: ['angY', 'angZ']` with `limits: {angY: [0, 0.5]}` limits the swing across X to 0.5 rad as one angle. `joint.setSoftness(hertz, damping)` (or the `softness` option) lets a joint's locks give way as a spring of its own, per kilogram so a light body and a heavy one sag alike by g over (2 pi hertz) squared, and `0` makes it rigid again. `joint.setDamping(c)` and `joint.setFriction(f)` put a drag (c times the speed) or dry friction (at most f) on a hinge or slider.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
const wall = physics.addBody(null, {type: 'fixed'});
const load = physics.addBody(null, {position: [0, -2, 0], colliders: {shape: 'sphere', radius: 0.25, mass: 10}});
const winch = physics.addJoint(wall, load, {
  type: 'rope',
  length: 2,
  userData: 'hoist',
  motor: {targetVelocity: -1, damping: 200, maxForce: 2000},
});
for (let i = 0; i < 60; i++) physics.step();
console.log(load.position[1] > -1.2, winch.userData); // true 'hoist' (reeled in 1 m)
winch.enabled = false; // the load falls free
for (let i = 0; i < 30; i++) physics.step();
console.log(winch.enabled, winch.force); // false [0, 0, 0]
physics.dispose();
```

### Debug lines

`physics.debugRender(options)` returns debug-render data: `vertices` (x, y, z, two vertices a segment) and `colors` (r, g, b, a a vertex) for the outlines of every collider (all shapes, a compound by its parts, a mesh by its edges, a voxel grid by its box), a line across each joint with a line from each anchor to its body (dark red once broken), and each contact point of the last step with a short line along its normal. `boxes: true` adds the world box of each collider; `colliders`, `joints` and `contacts` switch their lines off; `filter` takes a query filter (kind and sensor flags, `exclude`, `groups`, `predicate`) and draws only the colliders it sees, their contacts, and the joints between bodies that are shown. Colours: green awake dynamic bodies, grey fixed, blue kinematic, dim green sleeping, yellow sensors, red joints, magenta contacts, translucent cyan boxes. Draw them with `@margoengine/lines`.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [5, 0.5, 5]}});
physics.addBody(null, {position: [0, 0.6, 0], colliders: {shape: 'sphere', radius: 0.5}});
physics.step();
const {vertices, colors} = physics.debugRender({boxes: true});
console.log(vertices.length / 6 > 12, colors.length / 4 === vertices.length / 3); // true true
physics.dispose();
```

### Multibody joints

`physics.addMultibody(root, links)` holds a tree of bodies to reduced coordinates, (multibody joints). Each link names its `body`, the body it hangs from (`parent`, default the link before it) and a `joint` of locks: `fixed`, `revolute`, `prismatic`, `spherical` or `generic`. The joints are made for you and are ordinary joints too, with their limits, motors and break limits. The tree adds what plain joints cannot give: every substep the speeds of the links are projected onto the joint space (the least change of kinetic energy that keeps every joint closed, the normal equations of Featherstone's joint-space inertia matrix, 2008, solved over the tree with articulated-body inertias in time proportional to its links), and a link that has moved more than 1 mm or 1 mrad from where its parent and joint place it is put back, with the correction fed back as a speed (SHAKE with RATTLE). A branch is as exact as a chain: a tree with 1000 kg ends that plain joints throw 42 m apart holds within 1 mm, and a hinge limit holds to 1e-7 rad where plain joints overshoot by a fifth. Contacts on a link share their impulse through the joints as an articulated body would. A tree has no size of its own (it uses the scratch rows of its joints, which grow with the world), a body is in one tree, and a removed joint or body dissolves its tree (`multibody.remove()` frees it on purpose).

A multibody reads where one link would be with `forwardKinematics(body, coordinates?)`, a point's Jacobian with `bodyJacobian(body, point?)`, the joints to a body with `kinematicBranch(body)`, and moves its coordinates by `applyDisplacements(deltas)`; a `kinematicPosition` body in `links` is a kinematic link that `setCoordinates` drives, and `inverseKinematics` takes `constrain: {position, rotation}` masks for the world axes that count. It reads its tree with `numLinks`, `attachedBodies()`, `linkIndex(body)`, `bodyAt(index)` and `jointBetween(a, b)`, and `multibody.selfContacts = false` makes no two bodies of the tree touch (the default, true, leaves each joint's own `contactsEnabled` to decide for the pair it holds).

`multibody.coordinates()` lists the joint coordinates link by link (an offset in metres for each free linear axis, an angle in radians for a hinge counted past a whole turn, the rotation vector for a ball), `setCoordinates(values)` poses the tree from the root's pose, and `velocities()` reads each coordinate's speed. `multibody.inverseKinematics(link, {position, rotation}, options)` is Rapier's multibody inverse kinematics: damped least squares of the Jacobian over the joints between the root and the link (Buss 2004), with hinge and slider limits kept and a step bound (Buss and Kim 2005). It returns `{converged, iterations, positionError, rotationError}`. The dynamics of the tree in those coordinates: `multibody.massMatrix()` (`dof` by `dof`, symmetric positive definite: half the speeds times it times the speeds is the kinetic energy), `multibody.jacobian(link, point)` (six rows, the point's velocity then the link's spin, by `dof` columns, so the point moves at the Jacobian times `velocities()`), `multibody.inverseDynamics(accelerations, {gravity})` (the recursive Newton-Euler method of Walker and Orin 1982: the torque of each coordinate, in newtons for a slide and newton metres for a turn, that gives those accelerations; with none it is the bias, what holds the tree against gravity and the speeds' Coriolis and centrifugal terms) and `multibody.forwardDynamics(torques, {gravity})` (the accelerations torques give: H qdd = tau minus the bias). The root is the frame of the tree and does not accelerate; gravity defaults to 9.81 down y. Rapier poses a multibody from its joint coordinates and ignores a body's speed or pose at the time the joint is made; here the bodies' poses are read as given, so `setCoordinates` or `inverseKinematics` is how you place a tree.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
const shoulder = physics.addBody(null, {type: 'fixed'});
const arm = [1, 2, 3].map((i) =>
  physics.addBody(null, {position: [0, -i, 0], colliders: {shape: 'sphere', radius: 0.05, mass: 1}}));
const tree = physics.addMultibody(shoulder, arm.map((body) => ({
  body,
  joint: {type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0], anchorB: [0, 1, 0]},
})));
const found = tree.inverseKinematics(arm[2], {position: [1.2, -1.4, 0]});
console.log(found.converged, found.positionError < 1e-3); // true true
for (let i = 0; i < 60; i++) physics.step();                // swings from there under gravity, its joints closed
console.log(Math.abs(Math.hypot(...arm[0].position) - 1) < 1e-3); // true
physics.dispose();
```

### Reading a body

A body reads and sets `linearDamping`, `angularDamping`, `dominance` and `gyroscopicForces` (on by default here; Rapier's default is off), and reads `inverseMass`, `inversePrincipalInertia`, `worldCenterOfMass`, `velocityAtPoint(point)`, `kineticEnergy`, `gravitationalPotentialEnergy(gravity?, dt?)`, `nextPosition` and `nextRotation` (the pose a kinematic position body is to reach), `effectiveInverseMass`, `effectiveAngularInertia`, `effectiveWorldInverseInertia` (locked axes take their freedom out) and `isMoving`. `predictPositionUsingVelocity(dt)` and `predictPositionUsingVelocityAndForces(dt)` give the pose after `dt` seconds without moving the body, and `copyFrom(other)` takes another body's settings.

## Parity with Rapier 3D

Margo builds its own solver to replace Rapier, so every capability Rapier's public user guide lists (rigid bodies, joints, multibody joints, integration parameters, determinism, serialization, the PID controller and the debug-render pipeline) has a row here, with what the kernel and `margoengine/physics` hold today. `full` means built, typed, documented and proven by a test; `partial` names what is left; `missing` is not built. A row is closed in the commit that builds it, and the table shows what is left until every row reads `full`. Only Rapier's public user documentation was read to make the list, never its source or any other engine's.

### Dynamics and joints

| Capability (Rapier 3D) | Kernel and `margoengine/physics` | Status | Tests |
| --- | --- | --- | --- |
| Body types: dynamic, fixed, kinematic position-based, kinematic velocity-based | `addBody`, `setType`, `setNextPosition` | full | `next-bodies.test.js`, `next-events.test.js` |
| Pose, linear and angular velocity, teleport with or without waking | `setPosition`, `setRotation`, `setLinearVelocity`, `setAngularVelocity` | full | `next-bodies.test.js`, `next-dynamics.test.js` |
| Forces, torques, impulses, torque impulses, forces and impulses at a point, reset forces | `addForce`, `addForceAtPoint`, `addTorque`, `applyImpulse`, `applyImpulseAtPoint`, `applyTorqueImpulse`, `resetForces`, `resetTorques` | full | `next-dynamics.test.js` |
| Linear and angular damping, gravity scale | body options | full | `next-damping-gravity.test.js`, `next-dynamics.test.js` |
| Dominance groups | `dominance` | full | `next-dynamics.test.js` |
| Locked translation and rotation axes, per axis | `lockTranslations`, `lockRotations`, `enabledTranslations`, `enabledRotations` (options, and readable and settable on a body) | full | `next-dynamics.test.js` |
| Additional mass, additional mass properties, mass from colliders | `setAdditionalMass`, `setMassProperties`, collider density | full | `next-bodies.test.js`, `next-collider-api.test.js` |
| Additional solver iterations per body | `additionalSolverIterations` | full | `next-bodies.test.js` |
| Maximum linear and angular velocity per body | `maxLinearSpeed`, `maxAngularSpeed` | full | `next-speed-caps.test.js` |
| Sleep thresholds, can sleep, put to sleep, wake up | `sleepThreshold`, `sleepTime`, `canSleep`, `sleep`, `wakeUp` | full | `next-sleep-thresholds.test.js`, `kernel-sleep.test.js`, `next-bodies.test.js` |
| Enabled flag | `enabled` | full | `next-dynamics.test.js` |
| Continuous collision detection | `ccd` | full | `next-ccd.test.js` |
| Islands | island forest, an island sleeps together | full | `kernel-sleep.test.js`, `next-bodies.test.js` |
| Integration parameters: step length, substeps, solver iterations | `fixedTimestep`, `substeps`, `iterations` | full | `frames.test.js`, `next-physics.test.js` |
| Integration parameters: contact stiffness and damping ratio, joint stiffness, maximum corrective velocity, allowed linear error, warm starting share | `setSolver` | full | `next-parameters.test.js`, `kernel-solver.test.js`, `next-joint-share.test.js` |
| Integration parameters: prediction distance, length unit, maximum CCD substeps | `predictionDistance` (`tests/next-prediction.test.js`), `lengthUnit`, `maxCcdSubsteps` (`tests/next-parameters.test.js`) | full (a value above 1 of `maxCcdSubsteps` is the same as 1: the one pass resolves a whole sweep) | `next-prediction.test.js` |
| Step timing counters | `timing` | partial: the step and its seven phases; not Rapier's finer solver and CCD timers | `next-parameters.test.js` |
| Iterating the active bodies | `forEachActiveBody` | full | `next-parameters.test.js` |
| User data on bodies and colliders | `userData` | full | `next-parameters.test.js`, `next-collider-api.test.js` |
| Joints: fixed, revolute, prismatic, spherical, rope, spring, generic six-axis | `addJoint` | full | `next-joints.test.js` |
| Joint limits, per axis | `setLimits`, `setAxisLimits` | full | `next-joints.test.js` |
| Joint motors: velocity, position (stiffness and damping), force and acceleration models, maximum force | `setMotor`, `setAxisMotor`, `setRotationMotor` | full | `next-joints.test.js`, `next-motor-models.test.js`, `next-cone-motor.test.js`, `next-cone-motor-oracle.test.js` |
| Joint local frames and anchors, contacts between jointed bodies | `anchorA`, `frameA`, `contactsEnabled` | full | `next-joints.test.js`, `frames.test.js` |
| Joint anchors and frames set after creation, flip, user data, enabled switch, force and torque readback, joint list | `setAnchorA`, `setAnchorB`, `setFrames`, `flip`, `userData`, `enabled`, `force`, `torque`, `getJoints` | full | `next-joint-api.test.js` |
| Spring model (acceleration or force), rope motor (a winch), pin-slot joint | `spring` `model`, `rope` `motor`, `type: 'pinSlot'` | full | `next-joint-kinds.test.js` |
| Joint break on a force or torque threshold | `breakForce`, `breakTorque`, `jointbreak` | full | `next-joint-break.test.js` |
| Multibody (reduced-coordinate) joints and inverse kinematics | `addMultibody`, `coordinates`, `setCoordinates`, `inverseKinematics` | full | `next-multibody.test.js`, `next-multibody-oracle.test.js` |
| Multibody links and lookups, self contacts on and off | `root`, `links`, `numLinks`, `attachedBodies`, `linkIndex`, `bodyAt`, `jointBetween`, `selfContacts` | full | `next-multibody-api.test.js` |
| Limits on two or three turning axes of one generic joint | `limits` on `angX`, `angY`, `angZ` | full | `next-joint-limits.test.js` |
| Coupled axes of a generic joint, softness of a joint's locks, joint damping and friction | `coupled`, `setSoftness`, `setDamping`, `setFriction` | full (a hinge's own turning locks stay rigid under softness) | `next-joint-coupled.test.js`, `next-joint-softness.test.js`, `next-multibody-kinematics.test.js` |
| Multibody forward kinematics of one link, Jacobian, branch, displacements, kinematic links, IK masks | `forwardKinematics`, `bodyJacobian`, `kinematicBranch`, `applyDisplacements`, `constrain` | full | `next-multibody-kinematics.test.js` |
| Body reads: damping, dominance, gyroscopic switch, velocity at a point, predicted poses, energies, effective masses, copy | see Reading a body | full | `next-body-reads.test.js` |
| Cross-platform determinism | always on, there is no mode to switch: the kernel uses only + - * / sqrt, compares and integer operations, and `world.hash` is equal in Node, native code, Chromium and Firefox over 10,000 steps | full | `replay.test.js`, `kernel-step.test.js` |
| Snapshot and restore of a world | `world.snapshot()`, `world.restore()` | full | `kernel-solver.test.js`, `next-joints.test.js`, `next-parameters.test.js` |
| PID controller | `PidController` | full | `next-pid.test.js` |
| Debug-render data: colliders, joints, contacts, boxes | `debugRender` | full | `next-debug-render.test.js`, `next-debug-filter.test.js` |

### Features written over the kernel

| Capability (Rapier 3D) | `margoengine/physics` | Status | Tests |
| --- | --- | --- | --- |
| Kinematic character controller: offset, up vector, autostep, maximum slope climb angle, minimum slope slide angle, snap to ground, sliding | `createCharacterController` and `move` | full | `next-character.test.js`; `minSlopeSlideAngle` too |
| Character controller: pushing dynamic bodies, character mass, the collisions of a move | `applyImpulsesToDynamicBodies`, `characterMass`, `controller.collisions` | full | `next-character.test.js` |
| Dynamic ray-cast vehicle controller: suspension, engine, brake, steering, wheel friction | `Vehicle` | full | `next-vehicle.test.js` |
| Ragdoll with cone joints, motors and balance | `@margoengine/ragdoll` | partial: powered ragdolls on the cone joint differ from the spherical one, see KB-PHYS-SWITCH-CONE1 | `packages/ragdoll/tests` |
| Convex decomposition of a concave mesh | `convexDecomposition` from `margoengine/physics/decomposition` (CoACD) | full: build-time, never a bare mesh on `addBody` | `next-decomposition.test.js` |
| Colliders for a glTF model, one body or one per node | `addModel` | full | `add-model.test.js` |
| A body that follows a mesh | `follow: true` | full | `nested.test.js` |

## Limits

- Scale from a parent that shears a part is not represented: a body has a position and a rotation. Mesh scale is read once when a geometry-derived collider is built.
- Debug drawing is a line buffer from `debugRender()` for `@margoengine/lines`, not a renderer.
- Not built: soft bodies and cloth (Rapier's Soft-bodies page: builders, materials, tearing, finite elements, deformable colliders), see [docs/physics-collision-parity.md](../../docs/physics-collision-parity.md). Multibody joints, PID controllers and snapshots are built (see Parity with Rapier 3D).
- Ropes are rigid links, not soft bodies: a rope of many segments costs one body and one joint per segment.
- A `convexDecomposition` collider takes the result of `convexDecomposition` from `@margoengine/physics/decomposition`, not a bare mesh.
- The character controller, the vehicle and the rope are helpers written over the world with `Math.sin` and `Math.cos` for steering and slope maths; the world itself (the kernel and the TypeScript of a step) uses none, so a replay is the same bit for bit in every browser as long as no helper is in the scene.
- Changing `physics.gravity` wakes sleeping dynamic bodies, so they fall in the new field.
- A body removed while overlapping a sensor does not emit an end event.
- The engine passes `delta = 0` to `render()` unless you pass one, so a manual render loop must call `engine.render({delta})`; `engine.start()` does this for you.
- Open parity gaps with Rapier 3D are listed in [docs/known-bugs.md](../../docs/known-bugs.md) and [docs/physics-collision-parity.md](../../docs/physics-collision-parity.md).

## Tests

`npm test` builds the package and runs Node checks against the real kernel, a minimal fake mesh and core's real transform storage: resting boxes, restitution, deterministic irregular frame times, accumulator and interpolation, slerped rotation, joints and motors, sensor events, scene queries, triangle meshes, heightfields, mass and collision filters, forces and CCD, kinematic bodies, character movement (steps, walls, slopes, pushing a crate), rope and spring joints, ropes (link lengths, pins, removal), compound colliders (one collider, mass, one contact pair, gaps between parts), convex decomposition against a convex hull (a marble inside a hollow cup), vehicles (suspension load, driving, steering direction, rolling spin, braking, reverse from sleep, wheel meshes), gravity changes waking sleepers, root-only validation, nested PBR/core collider fitting with negative and nonuniform scales, animated-source rejection, failure rollback, debug buffers, and complete disposal. The kernel's own Rust tests are in `kernel/tests`. Rapier 3D is a test-only comparison: `tests/oracle.js` runs it as a black box (the wrapper in `tests/oracle/src`, built by `scripts/build-oracle.js`, over the root devDependency `@dimforge/rapier3d-compat`) so the parity tests hold the kernel to it on the same scenes. Nothing in `src` or `dist` imports it, and `tests/no-rapier-shipped.test.js` fails if anything does.

`npm run test:replay` runs the replay in real browsers, Chromium and Firefox by default (`REPLAY_BROWSERS`), with no WebGPU, and fails unless each gives the hashes in `tests/fixtures/replay-hash.json`. `npm run test:browser` runs it too, in the browser the other suites use, so the full check holds it on every machine. `node scripts/replay-golden.mjs` rewrites that file after a kernel change; the native test and every browser must then match it. `REPLAY_FIREFOX` names a Firefox to run in place of Playwright's own, for a machine where that one will not start.

`npm run test:browser` uses a real WebGPU engine in Chromium (`BROWSER_CHANNEL`, `BROWSER_EXECUTABLE`, `BROWSER_ARGS` as in the other packages): a stack of five boxes falls and settles, rendered world matrices match the interpolated physics poses while falling with variable frame times, readback pixels at the projected box centers match each box's color, a raycast from the camera returns the middle box mesh, there are zero WebGPU validation errors, and `engine.dispose()` frees the world.

Apache-2.0 licensed. The solver is Margo's own, written clean room from public papers; `docs/clean-room.md` lists its sources. Rapier is not redistributed.

## Content Security Policy

Wasm initialization needs `'wasm-unsafe-eval'` in `script-src` on restricted pages and worker responses. Blocked compilation rejects with MargoError code `failed` and a help link. See [the exact header and package requirements](../../docs/csp.md).
