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

## Sediment transport and bed change

`@margoengine/physics/sediment` reads shallow-water depth and discharge and routes suspended and bedload sediment.
It contributes the Exner elevation change to the same TerrainBed. Water then runs over the updated surface.

```ts
import { TerrainBed } from '@margoengine/physics/earth';
import { ShallowWaterSolver } from '@margoengine/physics/hydro';
import { SedimentTransport } from '@margoengine/physics/sediment';
import { PhysicsWorld } from '@margoengine/physics/world';

const grid = { columns: 4, rows: 2, width: 16, depth: 8, centre: [8, 4] as const };
const terrain = new TerrainBed();
const sediment = await SedimentTransport.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
world.add(terrain, { ...grid, elevations: () => 0 });
world.add(new ShallowWaterSolver(), {
  bed: terrain.bed,
  depth: 1,
  velocity: () => [1, 0],
  sides: { maxX: 'open' },
});
world.add(sediment, {
  grid,
  mobileDepth: 0.1,
  grainDiameter: 0.0003,
  open: { maxX: true },
});
world.advance(120);
console.log(sediment.read(1, 0), sediment.budget, terrain.volume());
```

Use the erodible thickness above the bedrock for `mobileDepth`. The registry exports layout-1 f64 cell grids
with concentration in kg/m³, bedload capacity in m²/s and shear in Pa. The `rootCohesion` input can add a
per-cell pressure from vegetation. `bankErodibility` activates lateral exchange in reaches with different
near-bank and mean water speeds. `budget` reports bed and suspended masses and boundary exports in kg.

## Rainfall runoff and channel inflow

`@margoengine/physics/runoff` turns rain and snowmelt into soil water, groundwater recharge and routed
discharge. It integrates the Green-Ampt wetting front, handles saturation on a wetness-index grid, and
routes excess water downstream using the implicit kinematic-wave balance.

```ts
import { bedSurface } from '@margoengine/physics/earth';
import { ShallowWaterSolver } from '@margoengine/physics/hydro';
import { RainfallRunoff } from '@margoengine/physics/runoff';
import { PhysicsWorld } from '@margoengine/physics/world';

const runoff = await RainfallRunoff.load();
const flood = new ShallowWaterSolver('valley', {
  field: runoff.outletField,
  outlets: [{ sourceCell: 2, position: [5, 5] }],
});
const bed = bedSurface({ columns: 2, rows: 1, width: 20, depth: 10, centre: [10, 5] }, new Float64Array(6));
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
world.add(runoff, { nx: 3, nz: 1, dx: 10, downstream: [1, 2, -1], rainRate: 0.0001 });
world.add(flood, { bed });
world.advance(120);
console.log(runoff.read(2, 0).outflow, runoff.budget, flood.budget.inflow);
```

The X index varies fastest. A downstream entry of `-1` is an outlet. Supply elevations or explicit
hydraulic slopes, and use `wetnessIndex` for the natural-log index (the Biomes Q8 values divided by 256).
Rain may come from the physical `Precipitation` contract or a layout-1 scalar or grid port in m/s.
An ATMO-09 water-flux port supplies snowmelt and evaporation. All published regions are layout-1
f64 grids. Depth and soil water use metres, infiltration and recharge use m/s, and channel and outlet
discharge use m³/s. The runoff budget measures every external gain and loss in m³. Match the area
upstream of a mapped outlet to the flood grid it feeds so direct flood rain and routed basin rain are each counted once.

## Rooted plants in wind and water

`@margoengine/physics/vegetation` models each plant as a tapered cantilever with two bending modes on each horizontal axis. Set its geometry, tissue density and Young’s modulus in SI units. A `FlowField` supplies the velocity and density of air or water at the plant and at the world clock's time.

```ts
import { PlantSway } from '@margoengine/physics/vegetation';
import { PhysicsWorld } from '@margoengine/physics/world';
import { BoundaryLayerWind } from '@margoengine/weather/boundary-layer';

const breeze = new BoundaryLayerWind({ speed: 6, roughness: 0.03, turbulence: false });
const sway = await PlantSway.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(sway, {
  flow: breeze,
  plants: [{ root: [0, 0, 0], height: 1.5, baseDiameter: 0.035,
    tipDiameter: 0.012, youngModulus: 8e8, density: 650, dampingRatio: 0.04 }],
});
world.advance(60);
const tip = sway.sample(0, 1.5);
console.log(tip.displacement, sway.dryFrequencies(0));
```

Each root is a position in the solver's origin cell, and the stem starts along +Y. A plant without a crown is all stem.
With no flow, the model reproduces free mechanical response. The tip diameter defaults to the base diameter,
`hollowRatio` to zero, and the stem drag coefficient to one. The added-mass coefficient defaults to one in water and
zero in air. Initial motion and internal damping default to zero. A crown can add distributed mass and projected drag
area above a given height. Its displaced volume defaults to zero and its drag coefficient defaults to the stem's.
Optional `ruptureStress` (Pa) and `anchorMoment` (N m) enable failure. The failure code, height, moment and world tick
are recorded in `swayField`. Its status is 0 standing, 1 snapped, or 2 uprooted. A stopped plant keeps its last computed
pose and velocity. An impact producer can project a horizontal hit at its height with `projectImpulse()` and publish the
result to `impulseField`. Both ports keep the order of `plants`. Snapshots include the modal state and any failure.
A supplied water `FlowField` uses the same interface. See [PlantMotion](../scatter/README.md#solved-plant-sway) to
render these motions in instanced foliage.

For rigid impacts, use `new PlantRigidSolver(sway)` in place of the world's `RigidSolver`. Pass `physics` and a binding
for each plant in solver order, with `null` for plants without rigid contacts. Give each binding an enabled fixed trunk
proxy and disabled dynamic fragments. A fragment at `baseHeight: 0` covers uprooting and root-level snaps. Other
fragments use the monitored section heights `height * index / 8` for index 1–7, with their pivots at those heights
and colliders extending along local +Y. Both bodies must exist before the world starts. If a fragment matches the
failure height, it takes the failed stem segment's orientation and velocity and the standing proxy is disabled.
Use `world.couple([rigid.id, sway.id], 'staggered')` to send that step's rigid contact load to the plant, then take
the first coupled snapshot after stepping at least once. The rigid solver and plant need the same origin.

```ts
import { Physics, type ColliderOptions } from '@margoengine/physics';
import { PlantRigidSolver, PlantSway } from '@margoengine/physics/vegetation';
import { PhysicsWorld } from '@margoengine/physics/world';

await Physics.load();
const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] });
const sway = await PlantSway.load();
const plant = { root: [0, 0, 0] as const, height: 1.6, baseDiameter: 0.08,
  density: 700, youngModulus: 1.2e8, anchorMoment: 0.5 };
const colliders: ColliderOptions = { shape: 'box', halfExtents: [0.04, 0.8, 0.04], offset: [0, 0.8, 0] };
const standing = physics.addBody(null, { type: 'fixed', colliders });
const trunk = physics.addBody(null, { colliders });
trunk.enabled = false;
const ball = physics.addBody(null, {
  position: [-0.45, 1.2, 0], colliders: { shape: 'sphere', radius: 0.12, mass: 1 },
});
ball.setLinearVelocity([4, 0, 0]);
const rigid = new PlantRigidSolver(sway);
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, 0, 0] })
  .add(sway, { plants: [plant] })
  .add(rigid, { physics, plants: [{ root: plant.root, height: plant.height,
    standing, fragments: [{ body: trunk, baseHeight: 0 }] }] })
  .couple([rigid.id, sway.id], 'staggered');
world.advance(20);
console.log(trunk.enabled, trunk.position);
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

Tyres, drivetrain and wheels that sweep a shape (all options of `Vehicle`, off by default):

```ts
import {Drivetrain, Physics, Vehicle, pacejkaTyre, type WheelOptions} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [100, 0.5, 100]}});
const chassis = physics.addBody(null, {position: [0, 1, 0], colliders: {shape: 'box', halfExtents: [1, 0.25, 2], mass: 1000}});
const drivetrain = new Drivetrain({axles: [{wheels: [2, 3], differential: {type: 'limitedSlip'}}]}); // engine, clutch, gearbox, differential
const wheel = (x: number, z: number, steer: boolean): WheelOptions =>
  ({position: [x, -0.1, z], radius: 0.35, steer, suspensionStiffness: 30, suspensionCompression: 4, suspensionRelaxation: 5});
const car = new Vehicle(physics, chassis, {
  tyre: pacejkaTyre(), // or brushTyre(), or {forces({slipRatio, slipAngle, load}) {...}}
  wheelCast: 'shape', // each wheel sweeps a cylinder of its radius and width, not one ray
  drivetrain,
  antiRollBars: [{wheels: [0, 1], stiffness: 20000}, {wheels: [2, 3], stiffness: 20000}],
  wheels: [wheel(-0.9, 1.4, true), wheel(0.9, 1.4, true), wheel(-0.9, -1.4, false), wheel(0.9, -1.4, false)],
});
for (let i = 0; i < 90; i++) physics.step();
car.setInput({throttle: 1, steer: 0.1}); // throttle drives the engine; `clutch` (0 to 1) is the pedal
for (let i = 0; i < 120; i++) physics.step();
console.log(drivetrain.gear, drivetrain.rpm > 900, car.speed > 2, car.wheel(2).slipRatio < 1); // 1 true true true
physics.dispose();
```

`pacejkaTyre({longitudinal, lateral, nominalLoad, loadSensitivity, combined})` is the Magic Formula of Pacejka and Bakker (1992), `F = D sin(C atan(B x - E (B x - atan(B x))))` against the slip ratio and the slip angle with each curve's `B`, `C`, `D` (the peak friction coefficient) and `E`, the peak falling with load, the two forces held in the friction ellipse where they meet; `brushTyre({friction, stiffness, halfLength})` is the brush model (a patch of bristles that stick and then slide, force `mu Fz (1 - (1 - theta s)^3)` along the combined slip, the slip taken over the wheel's surface speed, `kappa / (1 + kappa)`, cornering stiffness `2 c a^2`, 46.8 kN per radian by default, as the Magic Formula's defaults give at 4,000 N). With a tyre each wheel has a spin of its own (`inertia`, kg m squared): `engineForce` and `brake` are then forces at the contact patch, the slip ratio and slip angle come from the spin and the ground speed (`wheel(i).slipRatio`, `slipAngle`, `spin`, `load`), and the force a step gives is the one that agrees with the slip the step leaves. A `Drivetrain` takes the throttle in `setInput({throttle, clutch})` (negative at a standstill selects reverse): its torque curve (`torqueCurve`, `[rpm, N m]` points), `idleRpm`, `redlineRpm`, `engineInertia`, `gears`, `finalDrive`, `efficiency`, an automatic gearbox (`automatic`, `upshiftRpm`, `downshiftRpm`, shifting on the speed the wheels give the engine, and refusing limits that would shift up and straight back down, `shiftTime`) or `gear`, `shiftUp()` and `shiftDown()` by hand, a clutch of `clutchTorque` that holds or slips, and per axle a differential (`'open'`, `'locked'`, `'limitedSlip'` with `preload` and `bias`; `split` is the torque share of its first output) and between two axles a centre one. `antiRollBars` join two wheels and push the more compressed side up by `stiffness` newtons for each metre of difference. A wheel with `cast: 'shape'` (or the vehicle's `wheelCast`) sweeps a cylinder of its `width` and radius along the suspension, so it meets the lip of a slot or a kerb where one ray passes between them.

Tracked vehicles and motorcycles:

```ts
import {Motorcycle, Physics, TrackedVehicle, type WheelOptions} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [200, 0.5, 200], friction: 1}});

const hull = physics.addBody(null, {position: [0, 1.2, -20], colliders: {shape: 'box', halfExtents: [1.2, 0.4, 2.5], mass: 10000}});
const tank = new TrackedVehicle(physics, hull, {
  tracks: [-1, 1].map(x => ({position: [x, -0.3, 0], length: 3.6, roadWheels: 6})),
  maxSpeed: 8, // belt speed at full throttle, m/s
});
const frame = physics.addBody(null, {position: [10, 0.95, 0], colliders: {shape: 'box', halfExtents: [0.15, 0.3, 0.9], mass: 250}});
const wheel = (z: number): WheelOptions => ({position: [0, -0.25, z], radius: 0.3, suspensionRestLength: 0.25, suspensionStiffness: 30, suspensionCompression: 4, suspensionRelaxation: 5});
const bike = new Motorcycle(physics, frame, {front: wheel(0.7), rear: wheel(-0.7)});
frame.setLinearVelocity([0, 0, 10]); // a bike stays up by being ridden: start it rolling
for (let i = 0; i < 120; i++) physics.step();
tank.setInput({throttle: 0.5, steer: 0.2}); // belts at different speeds turn it
bike.setInput({throttle: 0.3, steer: 0.5}); // a turn asked for: the rider counter-steers, then leans into it
for (let i = 0; i < 120; i++) physics.step();
console.log(tank.speed > 1, bike.lean > 0.2, bike.leanTarget > 0.3); // true true true
physics.dispose();
```

A `TrackedVehicle` has tracks (a `position` where each is mounted, a `length`, `roadWheels` that each cast a ray and carry the hull on a spring): the belts are driven at `maxSpeed` times the throttle (`trackAcceleration` limits how fast a belt speeds up), the side a `steer` turns toward slower, so a steer with no throttle spins the hull on the spot, and the ground is pushed by how far each belt slips against it, with Wong's shear, `1 - exp(-j / shearDisplacement)` of the friction the load allows, `j` the displacement of the ground under the wheel (the slip speed added up while the belt is on it, renewed as the belt carries new surface in; `shearShare(j, K)` is the curve), the friction along the belt (`longitudinalFriction`) larger than across it (`lateralFriction`, the skid-steering resistance). A `Motorcycle` is a two-wheeled `Vehicle` (`motorcycle.vehicle`, on Magic Formula tyres) with a rider: it steers into the fall (`balanceGain`, `balanceDamping`), and a `steer` input is a turn it asks for (`maxLateralAcceleration`), which becomes the lean `atan(a / g)` that balances it and so is started by steering the other way, the counter-steer; `lean` and `leanTarget` read the angle, and `balance: false` lets the rider go.

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

## Explosions and wind

`explosion(physics, center, {impulse, radius, falloff = 'linear', lift = 0, filter})` gives every dynamic body within `radius` an impulse away from `center` at its centre of mass, scaled by the falloff (`'linear'` to nothing at the radius, `'inverse-square'` or `'none'`), with `lift` adding an upward share; it returns the bodies it pushed. `new WindForce(physics, {velocity, density, drag = 1.17, friction = 0.004, region, filter})` loads every dynamic body in `region` each step from its shape (AERO-01): each collider's surface is cut into panels (boxes, spheres, capsules, cylinders, cones, convex hulls and triangle meshes as themselves; other shapes as the box of their bounds), and each panel the air meets takes the flat-plate normal force `drag` sin(a) times the dynamic pressure 1/2 rho |w|^2 times its area, a the angle at which the air w (relative to the moving panel, so a spinning body feels its spin) meets it, plus skin friction `friction` along the surface. Summed about the centre of mass they give drag, the lift of an inclined surface and the moment of uneven loads (a gust that hits the top of a box harder tips it). `velocity` is a vector, a function of the point and the time (gusts, swirls), or a shared flow field of `@margoengine/math/fields` (a `Wind`, such as the atmosphere solver's), sampled at each body's centre at the world's time (`stepCount * fixedTimestep`, or a `PhysicsWorld`'s tick when an `AirSolver` steps it: the clock the rest of a scene shares) and in the world's frame (a field whose `cell` is `[0, 0, 0]`). `density` defaults to the flow field's at each body, or else the standard atmosphere's at the body's height (`standardDensity(y)` of `@margoengine/math/atmosphere`, y metres above sea level: 1.225 kg/m3 at 0, 0.736 at 5 km). The load is held on each body as a force through that step only and taken off exactly after it (in a world, through `bodyForces`), so a body the wind holds up keeps its height and keeps its own `addForce` to the bit when the wind stops, and it is taken implicitly in the body's motion (the drag of the speed the step ends with), so a sheet of paper in a gale follows the wind without overshooting it at 60 steps a second. A heavy body is slower to follow than a light one, a sleeping body is woken only by a wind that would push it a tenth of a metre a second squared, and `remove()` stops it. It was called `WindField` until 2026-11-25; that name still works and is deprecated, since `WindField` is the wind itself in `@margoengine/weather`.

```ts
import {explosion, Physics, WindForce} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.gravity = [0, 0, 0];
const crate = physics.addBody(null, {position: [1, 0, 0], colliders: {shape: 'box', halfExtents: [0.3, 0.3, 0.3], mass: 2}});
explosion(physics, [0, 0, 0], {impulse: 8, radius: 4});
const wind = new WindForce(physics, {velocity: (_point, time) => [0, 0, 4 + 2 * Math.sin(time)]});
for (let i = 0; i < 60; i++) physics.step();
console.log(crate.linearVelocity);
wind.remove();
```

## Universal joint and wheel joint

`addUniversalJoint(physics, bodyA, bodyB, {anchorA, anchorB, frameA, frameB, limitsX, limitsY, motorX, motorY})` joins two bodies at a point so that they turn about the X and Y axes of frame A and cannot twist about Z (a cardan joint): a generic joint with the sliding axes and the twist locked, so `joint.setAxisLimits` and `joint.setAxisMotor` change the limits and drives later. `addWheelJoint(physics, chassis, wheel, {anchor, wheelAnchor, frequency = 4, damping = 0.7, travel, maxTorque, steerable})` hangs a wheel from a chassis on a suspension along Y of the chassis frame (a spring of that natural frequency per kilogram between the travel limits) with the axle along X, and returns `{joint, knuckle, drive(speed), coast(), steer(angle)}`: `drive` spins the wheel toward a speed under the torque cap, and a `steerable` wheel hangs from a knuckle body that `steer` turns about the suspension axis. Swing-twist is the `cone` joint and a D6 is the `generic` joint; both exist already.

## Gear, rack and pinion, pulley, distance range

`new GearJoint(physics, bodyA, bodyB, {axisA, axisB, ratio})` keeps the angle of the first body about its axis plus `ratio` times the angle of the second constant (the two turn against each other at the ratio); `new RackAndPinionJoint(physics, pinion, rack, {pinionAxis, rackAxis, radius})` moves the rack `radius` metres a radian; `new PathJoint(physics, base, follower, {points, closed, anchor, motor: {speed, maxForce}})` holds a point of the follower on a Catmull-Rom spline through any number of points (2 or more, up to a million) fixed to the base, open or `closed` into a ring (3 or more points), found by a search that starts where the follower was and skips spans by their boxes (4 spans of a thousand sampled a search on a 1,000-point loop), free to slide along it, with an optional motor along the curve (`setMotor(speed, maxForce)`): a bead on a wire, a car on a rail; the follower keeps its own orientation. `new DistanceJoint(physics, bodyA, bodyB, {anchorA, anchorB, min, max, frequency, damping})` keeps two anchors between a least and a greatest distance and leaves them free in between (a rope has only a `max`, a strut only a `min`; with a `frequency` the ends give a little and pull back); `new PulleyJoint(physics, bodyA, bodyB, {groundA, groundB, anchorA, anchorB, ratio})` keeps the rope length on one side plus `ratio` times the other constant, as a rope that pulls and never pushes (an Atwood machine). Each is a row of the kernel's solve (`kernel/src/couplings.rs`), solved in every substep next to the joints and contacts with sequential impulses and a warm start (Catto, GDC 2011, for the soft form): rigid by default, or soft with `frequency` and `damping`; `correction` is the share of the position error a biased pass removes. A pulley follows an Atwood machine to one percent whatever the masses (3:1, 1.5:1 and 10:9 are in the tests), and a coupled pair is one island, so a resting gear train sleeps as one and a touch on one end wakes it all. The table of couplings grows with the world (a thousand gears in a train are in the tests). They act next to the joints that guide the bodies (hinge each gear and the pinion, slide the rack), `state()` reads the error and impulse, and `remove()` lets go.

```ts
import {GearJoint, Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.gravity = [0, 0, 0];
const wheel = (x: number) => {
  const post = physics.addBody(null, {type: 'fixed', position: [x, 0, 0], colliders: []});
  const body = physics.addBody(null, {position: [x, 0, 0], colliders: {shape: 'sphere', radius: 0.4, mass: 2}});
  physics.addJoint(post, body, {type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0], anchorB: [0, 0, 0]});
  return body;
};
const big = wheel(0),
  small = wheel(1);
new GearJoint(physics, big, small, {ratio: 2}); // the small wheel turns half as fast, the other way
big.setAngularVelocity([0, 0, 2]);
for (let i = 0; i < 60; i++) physics.step();
console.log(big.angularVelocity[2], small.angularVelocity[2]);
```

## Flight: wings, rotors and lifting gas

Three loads of `@margoengine/physics/flight` make a rigid body fly from its shape and its motion through the air (AERO-03). Each is solved again every step and held on the body as a force through that step only (the loads of one body summed, then taken off exactly after the step; in a world, through `bodyForces`, see `AirSolver`), taken implicitly in the body's motion, so a light body with a large wing stays stable at 60 steps a second.

- **`new WingForce(physics, body, {sections, forward = [0, 0, 1], up = [0, 1, 0], mirror = true, panels = [2, 4], wind, density, stall = 0.26, profileDrag = 0.008, separation, flap})`**: a wing as a vortex lattice (the method of `SailForce`). `sections` run from root to tip in the body's frame, each a `leadingEdge`, a `chord` and a nose-up `twist` (radians). With `mirror` the wing is a pair, mirrored across the plane of `forward` and `up`. So lift, induced drag, the moment about the centre of mass and the downwash between panels come from the planform and the attitude: a rectangular wing of aspect ratio 6 has the lift slope of a finite wing within 4 percent. Panels the air meets beyond `stall` separate: by default a fixed wing takes the flat plate's law and loses lift, and a flapping wing (`separation: 'flapping'`) takes the quasi-steady coefficients of Su et al. (`flatWingCoefficients`), whose leading-edge vortex keeps its lift. `flap(time)` returns `{stroke, pitch}` in radians: a rotation about the forward axis at the root, tip up, and a pitch of every section. The wing's own motion is part of the air each panel meets, so a downstroke pitched nose down pushes the body forward. `wing.force` and `wing.torque` are the last step's load, and `wing.circulation` each panel's circulation.
- **`new RotorForce(physics, body, {radius, chord, pitch, speed, hub, axis = [0, 1, 0], blades = 2, hubRadius, liftSlope = 2 pi, profileDrag = 0.008, stall, stations = 16, wind, density})`**: a rotor or propeller by blade-element momentum theory. Each annulus's induced velocity balances its blades' thrust against the momentum it gives the air. Thrust acts along `axis` for a positive `speed` (rad/s, or a function of time), and the rotor's torque turns the body the other way. `chord` and `pitch` are numbers or functions of radius. `rotor.evaluate(omega, inflow, density)` gives thrust, torque and power without stepping, and `rotor.thrust`, `rotor.torque` and `rotor.power` hold the last step's.
- **`new LiftingGas(physics, body, {volume, gas = 'helium', temperature = 373.15, centre, altitude, seaLevelTemperature})`**: buoyancy (rho_air - rho_gas) V g at the body's height in the standard atmosphere. `gas` is `'helium'`, `'hydrogen'` or `'hotAir'` (at `temperature`), so a balloon rises to the height where it floats. `gas.liftAt(height, g)` is the net lift there.

```ts
import {Physics} from 'margoengine/physics';
import {LiftingGas, RotorForce, WingForce} from 'margoengine/physics/flight';

await Physics.load();
const physics = new Physics(null);
// A glider (held level), a drone and a helium balloon.
const glider = physics.addBody(null, {linearVelocity: [0, 0, 15], lockRotations: true, colliders: {shape: 'box', halfExtents: [0.2, 0.1, 0.5], mass: 20}});
new WingForce(physics, glider, {
  sections: [
    {leadingEdge: [0, 0, 0.3], chord: 0.6, twist: 0.08},
    {leadingEdge: [3, 0, 0.2], chord: 0.4, twist: 0.06},
  ],
});
const drone = physics.addBody(null, {position: [10, 5, 0], colliders: {shape: 'box', halfExtents: [0.3, 0.05, 0.3], mass: 2}});
const rotor = new RotorForce(physics, drone, {radius: 0.3, blades: 2, chord: 0.03, pitch: 0.2, speed: 400});
const balloon = physics.addBody(null, {position: [-10, 2, 0], colliders: {shape: 'sphere', radius: 1, mass: 2}});
const gas = new LiftingGas(physics, balloon, {volume: 4});
for (let i = 0; i < 600; i++) physics.step(); // ten seconds
const [, vy, vz] = glider.linearVelocity;
console.log((vz / -vy).toFixed(1)); // 40.1: the glide ratio, metres forward for each metre down
console.log(rotor.thrust.toFixed(1), gas.lift.toFixed(1)); // 19.6 39.3: the drone climbs at its weight's thrust; the balloon rises
```

## Soft bodies

Ropes, cloth and particle meshes live in their own entry, `margoengine/physics/soft`, so a game that never imports it pays nothing: the root entry does not load it, and its kernel (a small Rust program compiled to Wasm) is a chunk of its own. Particles are held by compliant distance constraints (XPBD, Macklin, Müller and Chentanez 2016) solved in many small steps (Macklin et al. 2019); they collide with every shape of the rigid world (balls, boxes, capsules, cylinders, cones, hulls, meshes, height fields, voxels, compounds and half spaces; the rigid world is asked once a step for up to four planes each particle may meet, each collider swept along its own motion so a fast paddle cannot pass a particle, a deformable mesh's vertex speeds counted for friction, and sensors left out), and the bodies they press on take the impulse back, shared by the body's inverse mass and inertia, so a light crate on cloth sinks it and a heavy one sinks it more. The motion a contact gives a body reaches the body with its timing (what stops it at once, what holds it up over the step), and a body smaller than the gap between particles meets the triangles under it: a bead of a gram stays on a cloth of kilogram particles instead of sinking into them.

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
- **Settings.** `setPinnedParticles`, `setParticleMass`, `setMass`, `setMasses`, `setParticleRadius` (default half the shortest edge), `setSoftness(hertz, dampingRatio)`, `setMaterial(SoftBodyMaterial)`, `setEdgeTearResistance(strain)`, `setCollisionGroups(word)` (a collider's packed `collisionGroups`: which colliders the particles meet), `SoftBodyDesc.sphere(center, radius, {detail})` (a ball of triangles that holds its volume) with `setVolumeFactor(f)` on the description and on the body (`f` times the volume at creation: 1 keeps it, above 1 inflates; the spring is the material's `volumeSoftness`, default exact) and `body.surfaceVolume()`, `setTensionOnly(true | edges)` (edges that resist stretch and not squeeze: a slack rope does not push, a taut one pulls; also on the body), `setCanSleep(on)` (default on: after two seconds with every particle slower than 2 mm/s a body stops being stepped until something touches it; `body.sleeping`, `sleep()`, `wakeUp()`, `canSleep`; bodies with cells, clusters or attached particles stay awake), `setDominanceGroup(group)` (a rigid body of a higher group is immovable to the particles, one of a lower group takes the whole correction), `setAdditionalSolverIterations(passes)` (the world runs `iterations` plus the most any soft body asks), `setSurfaceCollider(settings)` and `setNoSurfaceCollider()` (a surface collider made with the body; default none) and `setOriented(on)` (whether that surface knows its outside; default when it is closed), `setSelfContacts(on, {friction})` (the body's triangles, and those of other bodies that have it on, keep a particle radius apart with Coulomb friction between the layers: cloth falling on cloth stays outside it, found before it passes through by the continuous point-triangle and edge-edge search of the shared kernel library, Bridson et al. 2002, Harmon et al. 2008), `setShapeMatching(on)` (every particle is pulled toward its place in the best-fit rotated rest shape, Müller et al. 2005, with the rotation found as in Müller et al. 2016; `shapeMatchingSoftness` on the material sets the spring, 0 Hz holds it rigid), `setGravityScale`, `setLinearDamping`, `setTranslation`. A natural frequency of 0 makes an edge rigid, the default for stretch edges (the rigid edges of a rope or a tree, a sheet's threads, the links of bodies to particles and the contacts of particles and faces with bodies are solved exactly, together (contacts with another soft body's surface or deformable collider stay in the sweep, since that surface moves with particles of the same solve), so how far they stretch does not depend on `iterations`, `substeps` or the mass of the load; rigid edges in other loops, a sheet braced with both diagonals of every cell say, keep the sweep); bend edges default to 10 Hz. A woven sheet's threads are not rigid by default: see Cloth below.
- **Particles.** `particlePosition(i)`, `particlePositions(target?)` (a copy, or written into a `Float32Array` of three numbers a particle so a frame loop allocates nothing), `particleVelocity(i)`, `particleVelocities()`, `setParticlePosition` (a teleport), `setParticleVelocity`, `setParticlePinned`, `setParticleKinematicTarget` (a pinned particle that travels to the target over the next step, so contacts and friction see it move), `attachParticle(index, rigidBody)` and `detachParticle(index, body?)` (a point-to-point link at the particle's place now: the body carries the particle and takes its pull back, shared by inverse mass and inertia, so a rope hangs a crate), `edges()`, `bendEdges()`, `isEdgeTorn`, `tearEdge`.
- **Drawing between steps.** `body.interpolatedPositions(alpha, out?)` gives every particle between where the last step began and where it ended, by `alpha` (default the world's `physics.alpha`, held to 0..1), so a cloth drawn each frame moves smoothly when the frame rate and the step rate differ, as rigid bodies do through `physics.sync`; `body.interpolatedMeshVertices(alpha)` does the same for a skin. `particlePositions()` stays the stepped state, and a teleport (`setParticlePosition`) leaves no trail.

```ts
import {Physics} from 'margoengine/physics';
import {SoftBodies, SoftBodyDesc} from 'margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null);
const soft = await SoftBodies.attach(physics);
const flag = soft.create(SoftBodyDesc.cloth([0, 2, 0], [0.1, 0, 0], [0, -0.1, 0], 8, 6).setPinnedParticles([0, 5]));
physics.update(1 / 144); // a 144 Hz frame: no step yet, a share of one is due
const drawn = flag.interpolatedPositions(); // where to draw the flag this frame
console.log(physics.alpha, drawn.length);
```
- **Forces.** `addForce`, `addParticleForce`, `resetForces`, `applyImpulse` (shared by mass), `applyParticleImpulse` and `applyImpulseAtPoint(impulse, point, radius)` (linear falloff to zero at `radius`, the whole impulse when the radius is zero or less) and `applyRadialImpulse(center, magnitude, radius)` (outward from the centre, the same falloff; all divided by each particle's mass). Pinned particles ignore them.
- **Deformable colliders.** `soft.createDeformableCollider(body, {vertices, indices}, binding, settings)` makes a deformable triangle-mesh collider of any mesh whose vertices follow the body, with their speeds, by `SoftMeshBinding.direct(particles)` (vertex `i` is particle `particles[i]`), `SoftMeshBinding.directByPosition(eps)` (each vertex is the nearest particle within `eps` metres) or `SoftMeshBinding.skinned()` (each vertex rides the tetrahedral cell that holds it); it goes with the body. A body with a skin (`setSkin`) collides by its skin: `soft.createSurfaceCollider(body)` uses the skin's mesh.
- **Contact hook.** `soft.setContactHook(contact => ...)` is called once a step for each contact a particle or a face has with a collider that asks for it (`collider.setActiveHooks({modifyContacts: true})`), with the plane (`normal`, `point`), the surface `velocity`, the `friction` and `enabled`, all editable; a face's contact also names its triangle's three particles (`face`) and their `weights` at the point it holds (both null for a particle's): a one-way platform sets `enabled = false` while the particle moves up, a conveyor edits `velocity`. Pass null to stop it.
- **Default contacts.** A body made with no configuration already rests on every rigid collider, both ways (the body pushed takes the push back): its particles meet them through the swept contact query, and its triangles, thickened by the particles' radius, meet what lies over their inside through the face query (`physics.softFaceContacts`), so a bead, a thin rod or a small box smaller than the gap between particles rests on a cloth instead of slipping through. Each contact holds what it meets the way the surface it was found on is: a face by its plane, which turns with the body, a round body (a ball, a capsule, a cylinder's side) or a corner from its centre of curvature, so the push on the body and on the cloth lie on one line and a light body is not set spinning. The rigid body takes the push with the timing it had: what stopped it lands at the start of the rigid step, what holds it up as a force over the step, and its spin as the change the soft step gave it. It has no surface collider unless you ask for one (Rapier makes one by default): the particles and the faces are the contact, and a rigid mesh on top would answer a second time (a box would rest on the mesh and never load the cloth).
- **Surface collider.** `soft.createSurfaceCollider(body, {friction})` gives a body made from triangles (`trimesh`, `cloth`, `clothTube`) a deformable triangle-mesh collider that follows its particles each step with each vertex's speed, so every rigid shape, convex hulls and meshes included, rests on cloth and is dragged by its friction; particles meet every shape directly through the kernel's swept particle probe. It is removed with the body.
- **Drawing.** `drawSoftBody(engine, body, {material, images, uvs})` from `margoengine/gltf/soft-mesh` draws a cloth or any body with triangles as a PBR mesh that follows it every frame, normals and tangents recomputed and texture coordinates from `body.grid` (`{nu, nv, wrap}` for a body built by `cloth`, `clothAnisotropic` or `clothTube`, null otherwise); see the gltf README.
- **World.** `soft.create`, `soft.remove`, `soft.list()`, `soft.onTear(listener)`, `soft.hash()` (equal across two runs that did the same), `soft.substeps` (default 8) and `soft.iterations` (default 2), `soft.dispose()`.

### Cloth: woven fabric as measured

A woven sheet (`cloth`, `clothTube`, `clothAnisotropic`) is a fabric. By default it is cotton shirting as Kawabata's KES-F instruments measured it (Luible, *Study of mechanical properties in the simulation of 3D garments*, Universite de Geneve, 2008, Annex C, sample 2), and `FABRICS` holds the others: `woolGabardine`, `silk`, `canvas` and `sailcloth`. No published KES-F measurement of a canvas or a sailcloth was found, so those two are the nearest measured fabrics, a jute plain weave and a polyester plain weave, and say so in their `source`. `desc.setFabric(fabric)` or `SoftBodyMaterial.fabric(fabric)` uses one. Presets are representative, not exact: the same named fabric measured elsewhere differs by up to ten times (weave, finish, humidity), so set measured values for a fabric that must match one.

- **Stretch.** Each warp and weft thread is a spring of the fabric's tensile stiffness, 2 WT / EMT^2 per width (`fabricTensileStiffness`: the linear spring that stores the energy measured up to the strain at 500 gf/cm), held in the exact solve with its compliance, so the stretch does not depend on the iterations or the load's mass. It holds from 0 to EMT, where the real fabric (whose curve stiffens, LT under 1) is softer at the highest loads and stiffer at the lightest; past EMT a thread is held rigid at that strain (strain limiting, Provot 1995). `material.tensile = null` holds the threads inextensible, solved exactly to 0.1 percent strain (Goldenthal et al. 2007).
- **Shear.** Each cell's diagonals are springs of the fabric's shear rigidity G, G L^2 / (2 a b) on a diagonal of length L across a cell of sides a and b (G itself on a square cell), so the cloth shears alike at any resolution (`fabricShearStiffness`), damped by the shear hysteresis 2HG at 0.5 degrees through Jacobsen's equivalent viscous damping (`fabricShearDamping`).
- **Damping.** The threads lose what the fabric's tensile resilience RT says a stretch cycle loses, zeta = (1 - RT) / (4 pi) (`fabricTensileDamping`, Jacobsen 1930).
- **Weight.** A woven sheet given no mass weighs its fabric's areal density (`material.arealDensity`, 0.12 kg/m^2 for cotton shirting), each particle a third of the triangles around it.
- **Air.** The faces of a body of triangles feel the air (`desc.setAirDrag(on)`, default on): a flat plate's drag, 1/2 rho 1.17 A |u_n| u_n (Hoerner 1965) on the air moving through each face, against `soft.wind` (a velocity, a function of the point and the time, or a flow field; still air when unset), rho the flow field's or the standard atmosphere's at the face's height. A `SailForce` on a cloth supplies its air loads instead, and turns this off for that cloth while it is attached.
- **Friction.** Contacts with rigid bodies hold back a slide within Coulomb's bound, solved with the sheet's rows (staggered projections, Kaufman et al. 2008), so a box on a cloth holds below its friction angle and slides above it.

Migration: before this, a woven sheet's particles weighed 1 kg each (Rapier's default), its threads and diagonals were rigid edges that the sweep left stretching under load, and it felt no air. A cloth of 10 cm cells then weighed 100 kg/m^2, eight hundred times cotton, which is why it sagged and draped like a heavy blanket. For the old behaviour, give the body `setParticleMass(1)`, set `material.tensile = null` and `material.shear = null` (rigid threads and diagonals, now solved exactly) and `setAirDrag(false)`; `SoftBodyMaterial.uniform(hertz, damping)` (Rapier's material) does all but the air.

```ts
import {Physics} from 'margoengine/physics';
import {FABRICS, SoftBodies, SoftBodyDesc} from 'margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null);
const soft = await SoftBodies.attach(physics);
soft.wind = [4, 0, 0]; // a 4 m/s breeze along x
// A 2 m flag of sailcloth, pinned along its staff (the j = 0 column).
const flag = soft.create(
  SoftBodyDesc.cloth([0, 2, 0], [0.1, 0, 0], [0, -0.1, 0], 21, 11).setFabric(FABRICS.sailcloth).setPinnedParticles(
    Array.from({length: 11}, (_, j) => j),
  ),
);
for (let i = 0; i < 120; i++) physics.step();
console.log(flag.particlePosition(20 * 11 + 5)[0] > 1); // true: the flag streams downwind of its staff
```

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
- **Tearing.** A cell whose stretch strain (the Frobenius norm of the stretch minus identity) passes `tearStrain` is removed at the end of the step and stays torn; the cells around it hold what is left. `onTear` listeners get `{body, edges, cells}`, `body.tornCells()`, `isCellTorn(cell)`, `tearCell(cell)`, `cells()` (four particle indices a cell), `numCells()`, `volume()` (cells not torn, as they stand) and `restVolume()` read and change it. A bar torn clean through is two pieces, joined by no cell. A tear that parts a body makes pieces of it (`soft.splitOnTear`: `'cells'` by default, `'all'` to split rope-like bodies of edges too, `'never'`): the cells that tore part from every cell they were joined to and, with the torn cells they touch, go on as pieces of their own, so no volume or mass is lost, the particles along a crack are duplicated, one for each side that meets there (the virtual nodes of Molino, Bao and Fedkiw 2004), and each part that no longer joins another becomes a soft body of its own with the rest shapes, plastic flow, rest lengths and masses of what it took, so the old body is removed and its tear event carries `pieces` and `destination(particle)` (where each of its particles went: both sides of a crack). `soft.tear(body, {cells, edges})` tears what you name at once and splits; `soft.cut(body, [a, b, c])` cuts along a triangle blade: every face between cells on the two sides of the blade's plane that lies inside the blade is parted, cells are not cut in two, and no material is removed. A body of edges with triangles (cloth, a trimesh) splits too: each piece takes the triangles whose corners and sides it holds, its self contacts and a surface collider of its own (the old one goes with the old body); a crack that does not part the cloth leaves its triangles out. A body of cells splits with its surface too: `box`, `solid`, `volumetric` and `cuboid` give the body the triangles of its surface (`desc.setSurface()` makes them for any cells), so `soft.createSurfaceCollider(body)` works on a solid, and each piece takes the boundary faces of its own cells, the faces along the crack included, and a surface collider of its own. Shape matching (each piece takes the rest offsets its particles had), the volume constraint of a closed surface (the same factor of the piece's own rest volume) and the skin (the vertices bound to its cells, with its triangles) go with the pieces. The tear can be shaped: `SoftBodyMaterial.tearForce` tears a structural edge pulled harder than that many newtons; `tearSmoothing` (on both materials, seconds) smooths the load so a spike does not tear; `CellMaterial.interiorStrength` makes a cell with no outside face and no torn neighbour that much tougher, so a tear starts at the surface or at damage; `maxTearsPerStep` caps the elements a body tears in a step, the most loaded first (a load past twice its threshold tears regardless); `minPiece` makes a tear that would split off fewer cells than that wait.
- **Clusters.** `desc.setClusters(groups, hertz)` holds each group of particles to its rest shape by shape matching (Müller, Heidelberger, Teschner and Gross 2005), turned and moved to where the group stands, as an implicit spring of `hertz`, so it is stable at any stiffness; groups may overlap and the cells may be soft. A block twisted by 0.6 rad and let go with a cluster returns to its shape within 0.1 mm; without one the twist stays in.
- **World.** `soft.cellDamping` (per second, default 10) damps every cell's constraints so a struck body stops ringing; `soft.substeps` and `soft.iterations` set the small steps as for edges: a stiff body wants more (the cantilever test uses 20 and 20, the example above 20 and 8).

- **Builders from meshes.** `SoftBodyDesc.volumetric(vertices, indices, size, skinned)` fills a closed, outward triangle mesh with cells of `size` metres (every lattice cube that holds or touches the mesh is kept, so the body contains the mesh); `cuboid(centre, halfExtents, counts)` is `box` by centre. `setSkin(vertices, indices)` binds a mesh to the cells that hold its vertices (barycentric coordinates in the cell); `body.meshVertices()` and `meshIndices()` read it back for drawing. The skin follows the cells and does not collide.
- **Clusters and frames.** `body.addCluster(indices, hertz = 0)` makes a cluster (its number comes back), `numClusters()` counts them, `removeCluster(cluster)` removes one. A cluster has a frame, its centre and the rotation that best fits its particles (Müller et al. 2005): `body.clusterProxy(cluster)` is a dynamic rigid body standing at it, with the cluster's mass and velocity and no gravity, that you can join (`physics.addJoint(anchor, proxy, ...)` holds the cluster up) or give colliders; the rigid world's change to its velocity is handed to the particles at the next step. `body.rootBody()` is the proxy of a cluster of every particle. Per cluster: `setClusterStiffnessScale` (Young's modulus of the cells wholly inside), `setClusterEdgeSoftness`, `setClusterTearResistance`, `enableClusterShapeMatching(cluster, on, hertz)`, `setClusterPinned`, `setClusterKinematicTarget(cluster, position, rotation)` (every particle goes to its place in the pose, pinned there).

- **The implicit solver.** `desc.setSolver('fem')` (or `body.setSolver`) holds a body's cells with one linear solve a substep, the linearly implicit step of Baraff and Witkin (1998) with the co-rotated stiffness of each cell and a conjugate gradient solve that never forms a matrix, instead of the constraints: its stiffness does not depend on the substeps and passes (a cantilever sags by the same 88 percent of the Euler-Bernoulli deflection at one substep of one pass as at eight of four, where the constraints with one pass sag more than twice as far, and a beam of 2 GPa holds at one substep), so use it for very stiff materials. `soft.femLinearTolerance` (relative residual, default 1e-5), `soft.femMaxLinearIterations` (default 20) and `soft.femMaxDenseDofs` (default 600: a body with that many unknowns or fewer is iterated until its residual is gone, as many passes as it has unknowns if need be, as a direct solve would finish) tune it. It works on the Neo-Hookean (forces of the stable Neo-Hookean stress, the stiffness of the co-rotated one: a quasi-Newton step to the same state) and co-rotated models; `'volume'` cells are always constraints, and the `Fem` bodies share the step with every other body.

#### Vertex block descent

`setSolver('vertex-block')` uses an implicit position update with the exact three-axis elastic Hessian of
each free vertex. It supports `neo-hookean` tetrahedra and shares the usual rigid contacts, kinematic
pins, and material damping. The world uses the configured soft `substeps` and `iterations`. Each iteration
sweeps the free vertices once, and high stiffness or large meshes can need more sweeps. The default
solver remains `'constraints'`. Change modes with `body.setSolver()` and use `body.solver` to read one.

```ts
import { Physics } from '@margoengine/physics';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';
import { PhysicsWorld, RigidSolver, SoftSolver } from '@margoengine/physics/world';

await Physics.load();
const physics = new Physics(null, { fixedTimestep: 1 / 60 });
const soft = await SoftBodies.attach(physics, { substeps: 4, iterations: 24 });
const wood = new CellMaterial();
wood.youngsModulus = 2e6;
wood.density = 650;

const beam = SoftBodyDesc.box([0, 1, 0], [0.7, 0.14, 0.14], [10, 2, 2], wood);
const ends: number[] = [];
for (let i = 0; i < beam.particleCount; i++) {
  const x = beam.positions[3 * i]!;
  if (x < 0.001 || x > 0.699) ends.push(i);
}
const rung = soft.create(beam.setPinnedParticles(ends).setSolver('vertex-block'));
physics.addBody(null, {
  position: [0.35, 1.23, 0.07],
  colliders: { shape: 'box', halfExtents: [0.053, 0.06, 0.06], mass: 35 },
});
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
  .add(new RigidSolver(), { physics })
  .add(new SoftSolver(), { soft })
  .couple(['soft', 'rigid'], 'staggered');
world.advance(60);
console.log(rung.solver, rung.particlePosition(49), world.hash());
```

#### Projective Dynamics

`setSolver('projective')` projects each tetrahedron onto a proper rotation and its original volume.
A global position solve then balances those targets against the inertia, the pin positions and
material damping. Use a `corotated` cell material. The Young's modulus and Poisson ratio keep their
small-strain meaning, with the rotation projection carrying shear and the volume projection carrying
bulk resistance. `soft.iterations` controls the number of local/global iterations per substep.
The global solve also uses the existing `femLinearTolerance`, `femMaxLinearIterations` and
`femMaxDenseDofs` settings.

```ts
import { Physics } from '@margoengine/physics';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null, { fixedTimestep: 1 / 60 });
const soft = await SoftBodies.attach(physics, { substeps: 4, iterations: 4 });
const material = new CellMaterial();
material.model = 'corotated';
material.youngsModulus = 2e6;
material.poissonRatio = 0.32;
const bar = SoftBodyDesc.box([0, 1, 0], [0.8, 0.2, 0.2], [8, 2, 2], material);
const pins: number[] = [];
for (let i = 0; i < bar.particleCount; i++) {
  if (bar.positions[3 * i] === 0) pins.push(i);
}
const body = soft.create(bar.setPinnedParticles(pins).setFiberStiffness([1, 0, 0], 1e7).setSolver('projective'));
for (let frame = 0; frame < 60; frame++) physics.step();
console.log(body.solver, body.volume());
```

`setFiberStiffness(direction, modulus)` adds an axial modulus in pascals in either nonlinear mode.
Give the direction in the same rest coordinates as the tetrahedral vertices. The default modulus
is zero, and passing zero clears a previously authored fiber. The additional stiffness acts in
tension and compression along that axis. It accompanies the body through cuts and snapshots.
For directional timber, the isotropic material gives the across-grain base stiffness. The fiber
adds the chosen extra stiffness along the grain.

#### Orthotropic timber

`setOrthotropicStiffness` gives every tetrahedron in a vertex-block body a complete directional
elastic law. Give the Young's moduli in X, Y, Z order and the shear moduli and Poisson ratios
in XY, XZ, YZ order. Moduli are in pascals. For example, XY means that tension along X
causes contraction along Y. The solver derives the reciprocal ratios from the same elastic energy.
By default the material axes are the rest-coordinate axes. To turn the material, supply
`axes` with a longitudinal direction and a second direction in the longitudinal–radial plane.
The directions must span a plane. Pass `null` to clear the tensor on the descriptor.

```ts
import { Physics } from '@margoengine/physics';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null, { fixedTimestep: 1 / 60 });
const soft = await SoftBodies.attach(physics, { substeps: 4, iterations: 8 });
const material = new CellMaterial();
material.density = 520;
const beam = SoftBodyDesc.box([0, 0.5, 0], [0.8, 0.2, 0.2], [8, 2, 2], material);
const pins: number[] = [];
for (let i = 0; i < beam.particleCount; i++) {
  if (beam.positions[3 * i] === 0) pins.push(i);
}
const rung = soft.create(beam.setPinnedParticles(pins).setOrthotropicStiffness({
  youngsModuli: [12e9, 816e6, 600e6],
  shearModuli: [768e6, 936e6, 84e6],
  poissonRatios: [0.292, 0.449, 0.39],
}).setSolver('vertex-block'));
physics.step();
console.log(rung.volume());
```

This example uses Douglas-fir ratios from the [Wood Handbook](https://research.fs.usda.gov/treesearch/62244).
The constants describe small-strain elasticity. Green strain supplies the geometric response as the
body rotates. The tensor supplies the entire elastic law. Use it by itself and keep the
`CellMaterial` for density, damping, yield and cohesion. Snapshots and cuts carry the authored axes
and all the stiffness coefficients.

Not in this entry yet: collision through a skin (see `docs/physics-collision-parity.md` for each row).

- **Sails and flags in the wind (AERO-02).** `new SailForce(physics, cloth, {wind, grid: [nu, nv], chord = 'u', density, stall = 0.35, drag = 1.17})` loads a cloth made by `SoftBodyDesc.cloth` with a vortex lattice on its own grid, solved again every step from where its particles are: each cell carries a horseshoe vortex (bound on its quarter chord, trailing from the leech along the apparent wind), the circulations stop the air passing through the sail at every cell's three-quarter chord, and each cell takes the Kutta-Joukowski force of its circulation, shared by its four corners. A cell the air meets more steeply than `stall` radians has separated and takes the flat plate's normal force instead (the `WindForce` law). So a sail's camber, twist and angle to the wind decide its lift (a flat sail of aspect ratio 6 has the lift slope of a wing of that aspect ratio), a sail run square before the wind is pushed, and the load reaches whatever holds the cloth. `chord` names the grid direction from the leading edge to the trailing edge; `wind` is a vector, a function of the point and the time, or a flow field such as `@margoengine/weather`'s `BoundaryLayerWind`; `sail.force` is the last step's total (the load that went into the cloth over the step) and `sail.circulation` each cell's. The load leans on the cloth's own speed through the air, so each corner takes it damped implicitly (backward Euler), and a sail of real sailcloth weight stays steady at the world's step. It is quasi-steady (no wake memory) and one surface thick. While attached it supplies the cloth's air loads: the cloth's own flat-plate drag (`setAirDrag`) is off for that cloth until `remove()`. It loads the cloth's particles, never a rigid body directly, so in a world the `SoftSolver` steps the cloth with the sail's load in it to the same bits as alone, and the load reaches the boat through what holds the cloth (the soft solver's `bodyImpulses` and `bodyForces`).

```ts
import {Physics} from 'margoengine/physics';
import {SailForce, SoftBodies, SoftBodyDesc} from 'margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null);
physics.gravity = [0, 0, 0];
const soft = await SoftBodies.attach(physics);
// A 1 m by 6 m sail, its chord along x at 5 degrees to a 10 m/s wind, held still to read its lift.
const a = (5 * Math.PI) / 180;
const desc = SoftBodyDesc.cloth([0, 0, 0], [Math.cos(a) / 4, -Math.sin(a) / 4, 0], [0, 0, 0.5], 5, 13);
const sail = soft.create(desc.setPinnedParticles(Array.from({length: 65}, (_, i) => i)));
const load = new SailForce(physics, sail, {wind: [10, 0, 0], grid: [5, 13], density: 1.2});
physics.step();
console.log(load.force[1] > 0); // true: lift across the wind
```

### Gas pressure in a closed shell

`setGasPressure({pressure, volume, ambientPressure})` uses absolute pressures in pascals. The optional `volume` is the
fill volume in cubic metres. It defaults to the enclosed mesh volume on a description and the current volume on a
live body. External pressure defaults to 101,325 Pa. The shell expands against its material and contacts, and the
fixed-temperature gas pressure falls as the volume grows. Use `gasState()` to read the current volume and both
pressures. `setVolumeFactor` switches back to a volume target or releases it with `null`.

<!-- example:node -->
```js
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc, SoftBodyMaterial } from '@margoengine/physics/soft';
import { PhysicsWorld, RigidSolver, SoftSolver } from '@margoengine/physics/world';

await Physics.load();
const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] });
const soft = await SoftBodies.attach(physics);
const material = new SoftBodyMaterial();
material.edgeSoftness = { naturalFrequency: 4, dampingRatio: 1 };
material.bendSoftness = { naturalFrequency: 2, dampingRatio: 1 };
const shell = soft.create(SoftBodyDesc.sphere([0, 0, 0], 0.5, { detail: 1 })
  .setMaterial(material).setParticleMass(0.06).setGasPressure({ pressure: 108_000 }));
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
  .add(new RigidSolver(), { physics })
  .add(new SoftSolver(), { soft })
  .couple(['soft', 'rigid'], 'staggered');
world.advance(8);
console.log(shell.gasState());
```

Keep the shell watertight and outward-wound. The model treats the chamber as one region of uniform pressure at
constant temperature. Each independently filled region is a separate soft body.

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
- **Film mode and exact frames.** With `film: true`, `update` never drops time (a one-second hitch runs sixty steps), and `physics.advance(frame, rate)` puts the world at frame `frame` of a shot rendered at `rate` frames a second, a whole number or the ratio `{num: 24000, den: 1001}`: exactly `floor(frame * stepsPerSecond / rate)` steps in all, worked out in integers, whatever frame rate or calls got it there, so a shot rendered at 24, 30, 60 or 24000/1001 frames a second, or resumed after a restore, is the same simulation (the `fixedTimestep` must be one over a whole number of steps a second). A world already past the frame throws a `state` error: restore a snapshot instead.

  ```ts
  import {Physics} from 'margoengine/physics';

  await Physics.load();
  const physics = new Physics(null, {film: true});
  physics.addBody(null, {position: [0, 5, 0], colliders: {shape: 'sphere', radius: 0.5}});
  for (let frame = 1; frame <= 48; frame++) physics.advance(frame, 24);
  console.log(physics.stepCount); // 120: two seconds of 1/60 s steps
  physics.dispose();
  ```
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
- **Debug drawing.** There is no built-in debug pass. `physics.debugRender()` returns line buffers (boxes, spheres, capsules, cylinders and cones as themselves, every other shape as the box around it), which `@margoengine/lines` draws directly: `lines.add(new Line({mode: 'segments', positions: vertices, colors, width: 1}))`, updated each frame with `setPositions` and `setColors`. The buffers are plain arrays, so a backend with no `Lines` (the WebGL2 preview refuses it, by its tier) draws them with plain WebGL2: one `gl.drawArrays(gl.LINES, 0, vertices.length / 3)` with the camera's view-projection as the matrix, as `tests/preview-browser.js` does and checks.
- **Lifecycle.** `dispose()` (or `engine.removePlugin('physics')` or `engine.dispose()`) removes every character controller, joint, collider and body, then the world. Handles become invalid (`body.valid === false`) and methods on them throw.
- **SSR safety.** Nothing touches `window`, `document`, `navigator` or GPU globals at import or construction time. `new Physics(null)` runs headless, for servers, workers and tests; call `physics.update(delta)` yourself.

## API

| Export | Purpose |
| --- | --- |
| `Physics` | The world and engine plugin: `update`, `step`, `sync`, `addBody`, `addJoint`, `createCharacterController`, `raycast`, `raycastAll`, `shapeCast`, `projectPoint`, `intersectPoint`, `intersectShape`, `touching`, `contactPoints`, `on`, `debugRender`, `dispose`; `kernel` is the solver's world, with its columns, `hash`, `snapshot` and `restore` |
| `PhysicsBody` | Pose, teleport (`setPosition`, `setRotation`), kinematic targets (`setNextPosition`, `setNextRotation`), velocities, `addForce`, `addForceAtPoint`, `applyImpulse`, `applyImpulseAtPoint` (both forms take a point too), `addTorque`, `applyTorqueImpulse`, `resetForces`, `resetTorques`, `appliedForce`, `appliedTorque`, `setAdditionalMass`, `setMassProperties`, `mass`, `centerOfMass`, `principalInertia`, `inertiaFrame`, `additionalPgsIterations`, sleep and wake, `gravityScale`, `ccd`, locks (`lockTranslations`, `lockRotations`, `enabledTranslations`, `enabledRotations`), `addCollider`, `removeCollider`, `remove`, `colliders` |
| `PhysicsCollider` | What `body.colliders`, events and query hits hand you, one object per collider: `shape`, `body`, `handle`, `valid`, `boundingRadius`, read and set `friction`, `restitution`, `density`, `sensor`, `enabled`, `collisionGroups`, `solverGroups`; `translation`, `rotation`, `translationWrtParent`, `rotationWrtParent`, `halfExtents`, `radius`, `halfHeight`, `vertices`, `indices`, `containsPoint`; for `voxels`, `setVoxel`, `combineVoxelStates`, `propagateVoxelChange`. It throws a `state` error once removed. |
| `PhysicsJoint` | `setLimits`, `setMotor`, `setRotationMotor` (spherical joints: a spring toward a rotation), `setAxisLimits` and `setAxisMotor` (generic joints: one axis), `clearMotor`, `anchorA`, `anchorB`, `contactsEnabled`, `remove` |
| `CharacterController` | `move(desired)` per fixed step, `grounded`, `collisions`, `platform`, `innerBody`, `onContact`, `dispose` |
| `DynamicCharacter` | `update()` per fixed step, `setTargetVelocity`, `setFacing`, `jump`, `grounded`, `platform`, `groundNormal`, `dispose` |
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
| `gravity` | `[0, -9.81, 0]` (`DEFAULT_GRAVITY` of `@margoengine/math/gravity`, the engine's one gravity) | Also `physics.gravity = [...]`; multibody `inverseDynamics` and `forwardDynamics` and a `Motorcycle`'s lean read it |
| `fixedTimestep` | `1 / 60` | Seconds per step |
| `maxSubsteps` | `4` | Steps per frame before the backlog is dropped |
| `film` | `false` | Film mode: `update` runs every step it owes and keeps the fraction of a step, so no time is dropped; `maxSubsteps` is not used |
| `interpolate` | `true` | Interpolate meshes between steps |
| `timeScale` | `1` | Slow motion or fast forward |
| `paused` | `false` | Paused worlds keep their meshes but do not step |
| `substeps` | `8` | Equal pieces each step is split into; more is stiffer stacks and joints. `iterations` (default 2) are the solver passes in each. `physics.substeps` reads and sets it later (`solverIterations` is its old name); `body.additionalPgsIterations` (default 0) adds passes for that body's island alone |
| `contactFilter` | none | `(a, b) => boolean \| 'noForces'` per candidate pair |
| `name` | `'physics'` | Plugin name, for more than one world per engine |

Frame order: `Physics` is a late plugin (core's `late`): the engine updates it after every plugin that is not, whichever was added first, so each frame it steps after the frame's animation and after a ragdoll or follower has set its targets from the pose drawn. A body whose pose comes from an animation (a ragdoll's hit boxes, a body following an animated mesh) is therefore on the pose drawn, on the frame it is drawn (KB-PHYS-FRAMEORDER1, fixed). The shot tool drives the page's own frame loop on the shot's clock, so a film has the same order.

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

Character controller options (a sphere, box, capsule, cylinder or cone collider on a `kinematicPosition` body): `offset` (0.01), `up`, `maxSlopeClimbAngle` (45 degrees), `minSlopeSlideAngle` (30 degrees), `autostep` (`{maxHeight: 0.3, minWidth: 0.2}` or `false`), `snapToGround` (0.2 or `false`), `slide`, `applyImpulsesToDynamicBodies`, `characterMass`. `offset`, `snapToGround` and the autostep's `maxHeight` and `minWidth` take metres or `{relative: share}` of the character's height along `up` (Rapier's `CharacterLength`); `normalNudgeFactor` (default 0.0001 m) pushes a sliding character off what it slides along so it does not catch. A move returns `{movement, grounded, collisions, slidingDownSlope}`, and the controller reads back Rapier's outputs: `isSlidingDownSlope`, `computedMovement()`, `computedGrounded()`, `numComputedCollisions()` and `computedCollision(i)` (`{collider, point, normal, translationApplied, translationRemaining}`). With `autostep.includeDynamicBodies` a dynamic body is a step it climbs. Moving ground: with `inheritPlatformVelocity` (on by default) a kinematic, dynamic or turning body the character stands on adds its velocity at the character's foot to every move and turns the character about `up` with it, and `controller.platform` is that body. `innerBody: {colliders}` makes a second `kinematicPosition` body that follows the character for other bodies to hit (the character's own cast never meets it, so its shape may differ from the one the character walks with), removed with the controller. `controller.onContact(listener)` calls `listener(contact)` for every obstacle as it is met (`{collider, body, point, normal, translationApplied, translationRemaining, canPush}`) and returns a function that removes it; clear `contact.canPush` to leave that body alone. Pushing: the character takes a dynamic body up to its own speed with the reduced mass of the pair, `maxPushStrength` (newtons, default no limit) caps the impulse of a step, and `maxPushMassRatio` (default no limit) leaves a body heavier than that many `characterMass` as a wall.

A character that is itself a dynamic body, pushed and knocked about by the solver, is a `DynamicCharacter` from `physics.createDynamicCharacter(body, options)`. It keeps the body upright with a stable proportional-derivative torque (Tan, Liu and Turk 2011: implicit in the position and the velocity, so any stiffness and any step is stable), walks it at a target velocity over the ground within a grip, holds it on slopes it can stand on and rides what it stands on:

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [50, 0.5, 50], friction: 0}});
const hero = physics.addBody(null, {position: [0, 0.8, 0], colliders: {shape: 'capsule', halfHeight: 0.4, radius: 0.3, friction: 0}});
const character = physics.createDynamicCharacter(hero, {uprightFrequency: 4, groundAcceleration: 60});
physics.on('beforestep', () => {
  character.setTargetVelocity([2, 0, 0]); // metres a second, relative to the ground under it
  character.setFacing([1, 0, 0]);
  character.update();
});
for (let i = 0; i < 120; i++) physics.step();
character.jump(Math.sqrt(2 * 9.81 * 1)); // a jump one metre high, from the ground only
physics.dispose();
```

Dynamic character options: `up` ([0, 1, 0]), `bodyUp` (the body's own axis that stands along `up`, [0, 1, 0]), `uprightFrequency` (4 Hz) and `uprightDamping` (1, no overshoot), `maxUprightTorque` (no limit; a limit lets a hard enough blow knock it over), `maxSlopeClimbAngle` (45 degrees; steeper is a slide), `groundProbe` (0.05 m), `groundAcceleration` (60 m/s squared, its grip: give the collider a low `friction` so this is the grip), `airAcceleration` (8) and `facingFrequency` (6 Hz). `hover: {height, frequency, damping, maxForce}` floats it `height` metres above the ground on a critically damped spring that also carries its weight (the reaction goes into a dynamic ground), so steps lower than the hover pass under it; `stairs: {maxHeight, minDepth}` lifts it onto a riser of that height or less with ground `minDepth` deep on top. Both are off by default.

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

Read views from `world.columns` each time: `reserve`, `addBody` and anything else that grows the memory can replace them. Each world is its own Wasm instance, living in a world memory: `new KernelWorld(bodies, colliders, {arena})` takes the `Arena` of `margoengine/physics/world` to live in (default: one of its own over a plain memory), and `new Physics(null, {arena: world.arena})` puts a `Physics` in a physics world's memory, where its rigid solver's state lies with every other solver's. The world's block, a 1 MiB stack and the 720 KiB of records the batch queries use are regions of that arena; the block grows through it and moves with one copy when it cannot grow in place, which changes no result. One rigid kernel per memory. A world on a shared memory uses the kernel's threaded build (`loadKernel({threads: true})`, Wasm SIMD and atomics), and then its islands can solve on worker threads: `await world.useThreads(count)` starts `count - 1` workers (the main thread is the last), `await world.stepAsync(dt)` steps with the islands split over them in fixed runs, the main thread solving the first, and `world.endThreads()` stops them. Islands share nothing a solve writes, so a step gives the same bits on any number of threads (`threadCount` reads how many). A shared memory needs a cross-origin-isolated page (or Node); the broad and narrow phases still run on the main thread.

```ts
import {KernelWorld, loadKernel} from 'margoengine/physics';
import {Arena, worldMemory} from 'margoengine/physics/world';

await loadKernel({threads: true});
const world = new KernelWorld(1024, 1024, {arena: new Arena(worldMemory(true))});
await world.useThreads(4);
await world.stepAsync(1 / 60);
console.log(world.threadCount); // 4
world.endThreads();
``` Gravity defaults to `[0, -9.81, 0]` (`world.setGravity(x, y, z)`) and each step runs 8 substeps (`world.substeps`) of 2 solver passes (`world.iterations`). A force in `forceX` and the columns beside it stays until you clear it and reaches every substep; an impulse in `impulseX` lands once, before the first. A body's mass, centre of mass and inertia come from its colliders; write `additionalMass` and call `world.updateMass(body)` to add weight, which is spread as the colliders are, so it scales the inertia too. A dynamic body with no mass does not fall. `world.removeBody(body)` and `world.removeCollider(box)` free their rows, and a later add takes the last one freed; a collider's row comes back after the next step.

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

It holds `box`, `sphere`, `capsule`, `convexHull`, `trimesh`, `heightfield`, `compound` and `voxels` colliders, bodies of every kind, forces, impulses, velocities, damping, locks, kinematic targets, gravity, sleeping and the `beforestep` and `afterstep` events. Bodies collide, with friction, restitution and the four combine rules, and `physics.touching(a, b)` and `physics.contactPoints(body)` read the contacts of the last step, walking only the asking body's pairs: `touching` allocates nothing, and a call costs that body's contacts, not the world's. Contact and intersection events, sensors, `collisionGroups`, `solverGroups`, `contactFilter`, `dominance` and `enabled` on bodies and colliders work, with the same names. `body.setType`, `setAdditionalMass` (with inertia of its own), `setMassProperties`, `collider.setDensity` and `additionalPgsIterations` work, . A call that needs what is still to come throws a `MargoError` with code `unsupported` naming what it waits for: the other shapes and `addModel` with the shapes and queries batch, `follow` and character controllers, and `debugRender`. `body.sleep()` and impulses take effect at the next step.

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

`shapeCastNonlinear(shape, position, rotation, {linearVelocity, angularVelocity, centerOfMass}, endTime, options)` casts a shape that turns as it travels, as Rapier's `cast_shape_nonlinear`, and gives the time of the first touch (found by conservative advancement, so no touch within the time is skipped; one convex shape, no predicate). `shapeCast`, `projectPoint`, `intersectPoint` and `intersectShape` work on every shape, with the names and the same filter options. The query shape is any convex one with its size given: `sphere`, `box`, `capsule`, `cylinder`, `cone`, `segment`, `triangle` or `convexHull`, the box and hull with their `borderRadius`. A `compound` (or a decomposed `convexDecomposition`) of those is a query shape too: it is cast and tested piece by piece. A `trimesh`, `heightfield` or `voxels` is a query shape as well: its triangles or cells are cast and tested one by one (a mesh is built in the world once for the options object you pass, so keep and reuse it). A `halfSpace` is a query shape too (the plane at the shape's position, turned by its rotation, and everything behind it): a cast stops when the plane meets a collider, and a start inside one is a hit at distance 0. `shapeCast` takes Rapier's cast options: `maxDistance` (default unbounded), `targetDistance` (stop this far short of touching, default 0), `stopAtPenetration` (default true: a cast that starts in contact hits at distance 0; false: one that starts in contact and moves out of it goes on) and `computeImpactGeometryOnPenetration` (default true: such a hit gets its normal and points; false leaves them zero). A hit gives the point and outward normal on the collider hit, and `queryPoint` and `queryNormal` on the cast shape. `projectPoint` takes `solid` (default true: a point inside a shape projects to itself, `inside` true, distance 0; false: to the nearest point of its surface). A trimesh or height field never holds a point.

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

Two colliders can be asked about directly, whether or not their bodies touch: `physics.contactPair(a, b, prediction = 0)` gives the contact manifolds within `prediction` metres (normal from `a` to `b`, and up to four points with the nearest point on each collider and their separation); each manifold also holds the normal in each collider's own frame (`localNormalA`, `localNormalB`), the sub-shape it is on (`subShapeA`, `subShapeB`: a compound's child index or a mesh's triangle), and each point its own frame's position (`localPointA`, `localPointB`) with the friction, restitution and surface velocity the solver reads (`friction`, `restitution`, `tangentVelocity`), `physics.intersectionPair(a, b)` whether they overlap, and `physics.colliderDistance(a, b)` how far apart they are with the nearest point on each, 0 when they overlap. A compound gives a manifold for each pair of children, a mesh or height field one for each triangle near the other collider (with the triangle's own normal: `fixInternalEdges` smooths only the world's contacts). `collider.aabb()` is a collider's tight box at its last step's pose (with its contact skin), `collider.sweptAabb(nextPosition, nextRotation)` the box that holds it now and at another world pose (Rapier's `compute_swept_aabb`), `collider.collisionAabb(prediction)` that box grown by the prediction distance (`compute_collision_aabb`), and `physics.intersectAabb(min, max)` the bodies whose colliders' boxes meet a box.

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

`setType` keeps the pose, colliders and joints: a body made fixed stops, and its touches with other fixed bodies end; one made `kinematicPosition` holds its pose until given a target; a dynamic or kinematic body keeps its velocity. With `wakeUp` (default true) a body made dynamic or kinematic wakes now; a sleeper otherwise, or one made fixed, reads asleep until the next step, which wakes it and what it touches whatever `wakeUp` said (measured). A kinematic body still for the sleep window reads asleep, as on Rapier, and a target wakes it. `setAdditionalMass(mass, inertia)` puts the mass at the centre of mass the body has now, so alone it leaves the inertia as it is, and replaces an earlier call, `setMassProperties` and the `additionalMass` option, which spreads its mass as the colliders are. `setMassProperties` sets the colliders' density to 0, and colliders added later add their own mass. `additionalPgsIterations` (any whole number from 0 to 4294967295, Rapier's 32 bits, ) gives the body's island that many passes more: it runs as a world of that many passes would, bit for bit, and the other islands are left alone.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [20, 0.5, 20]}});
// A crate held in place until it is let go, with a mass and inertia from a measurement.
const crate = physics.addBody(null, {type: 'fixed', position: [0, 0.5, 0], colliders: {shape: 'box', halfExtents: [0.5, 0.5, 0.5]}});
crate.setMassProperties({mass: 12, centerOfMass: [0, -0.2, 0], inertia: [2, 2, 2]});
crate.additionalPgsIterations = 4;   // a stiffer island, for a tall stack on top
crate.setType('dynamic');
for (let i = 0; i < 60; i++) physics.step();
console.log(crate.mass.toFixed(2), crate.position[1].toFixed(2)); // 12.00 0.50: on the floor it was touching
physics.dispose();
```

A `trimesh` takes `vertices` (flat x, y, z numbers) and `indices` (three a triangle, counter-clockwise seen from its front), or `geometry`, or the body's mesh. It is a surface: both sides collide, and it adds no mass, so it belongs on fixed and kinematic bodies or with `setMassProperties`. Each triangle a shape touches holds its own contact normal, so a box in a corner keeps the floor and the wall. `fixInternalEdges: true` keeps contacts on the seams between triangles to the normals the surface allows, so a ball or a box slides across a flat run of triangles without catching on their inner edges; it is off by default, as in Rapier. It also holds across two separate meshes that meet in one plane (the chunks of a terrain): a ball, capsule or box that stays within the depth the solver holds a resting shape at (the contact slop plus one substep of gravity, g h^2: 0.37 mm at the defaults) of the plane it rests on does not meet the open edge of the mesh it is about to cross, so it crosses the seam as it crosses one mesh. A step in a surface lower than that depth is climbed by the face's push rather than struck. `KernelWorld.addTrimesh(vertices, indices, {fixInternalEdges})` and `trianglesAcross(vertices, indices)` are the kernel's view of the same.

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

A `trimesh` can be cleaned before it is built, each step off by default: `mergeDuplicateVertices` joins vertices at one position, `deleteDegenerateTriangles` drops triangles with a repeated vertex or no area, `deleteDuplicateTriangles` drops a triangle another repeats, whatever its winding, and `deleteBadTopologyTriangles` drops triangles that would make an edge belong to more than two (later ones first), in that order; a mesh that loses every triangle is refused. `cleanTrimesh(vertices, indices, options)` from this entry runs the same steps for you to see. `oriented: true` says the mesh is a closed surface, so `projectPoint`, `intersectPoint` and a solid ray from inside treat a point inside it as inside (by the parity of the surface crossings of a ray from the point). Contacts are unchanged, except where a soft body's particle or triangle touches the mesh at no distance: it is pushed out along the surface's own normal there, the angle-weighted pseudonormal of the face, edge or corner it is on (Bærentzen and Aanæs 2005). That is how the two halves of a cut body, each on the other's surface, come apart. A `convexHull` also takes a mesh, `vertices` and `indices`, and is the hull of the vertices the triangles use, as Rapier's `convexMesh`.

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

A `compound` takes `parts`: boxes, spheres, capsules, cylinders, cones and convex hulls (a box or hull with a `borderRadius` too), and a `trimesh`, `heightfield` or `voxels` part as well (a surface, for a fixed body's scenery: a voxel part weighs nothing here; Rapier 0.21's JavaScript aborts when a compound has a triangle mesh part, and builds one with a height field or voxel part, which this solver matches). A mesh part meets the convex colliders and the parts of other compounds, and no mesh at all. A `halfSpace` is a part too (the plane through its offset): an endless floor beside a box. each with its own `offset` and `rotation` in the collider's frame, never fitted to the mesh. It is one collider, as in Rapier: one handle, one pair and one set of events against each other collider, and one `density` (or `mass`, spread by volume) for every part. Each part that touches keeps its own contact points and warm start, and parts are culled by their own boxes, so the gaps between them are empty. Its mass, centre and inertia match Rapier's for the same parts (a test holds them to 1e-5) and are the same bits as the parts added as colliders of their own. `boundingRadius` is null, as on the root entry. `KernelWorld.addCompound(body, parts, options)` is the kernel's view of it. `fixInternalEdges: true` (default false, as Rapier's `CompoundFlags.FIX_INTERNAL_EDGES`) treats the faces where two hull parts meet face to face as inside the union, as the cuts of a convex decomposition are: a ball or a box then crosses the join as it crosses one hull, where the unfixed compound kicks it by the edge of the part it is on (a ball over two parts at 4 m/s was thrown up at 0.8 m/s, and over the fixed join at 2e-6 m/s). The option is on `convexDecomposition` colliders too; it reads hull parts only, each with a hull of its own, and a step between parts is no join.

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

After each step a pair that began or stopped touching fires `contactstart` or `contactend`, or `intersectionstart` or `intersectionend` when either collider is a sensor, with both bodies, meshes and colliders. A sensor sees overlaps and pushes nothing, and it sees kinematic and fixed bodies too. Two fixed bodies never meet, sensor or not. A collider stays quiet with `events: false` when the other side has it too. A pair of sleepers says nothing. A fast body with `ccd: true` that passes through a sensor inside one step fires `intersectionstart` and `intersectionend` for it, though it is in it at neither end of the step. A collider or body removed while it touches ends the contact at once, and the end event, `removed: true` (Rapier's `CollisionEventFlags::REMOVED`), is delivered at the end of the next step, still naming both colliders. `collisionGroups` keeps a pair apart; `solverGroups` lets it be seen and fire events without being solved. Both take a packed `collisionGroups(memberships, filter)` number (16 + 16 bits, as Rapier's JavaScript build packs them) or `interactionGroups(memberships, filter, testMode)`, 32 bits wide as Rapier's Rust `InteractionGroups` is: masks or lists of group indices 0 to 31, tested by `'and'` (each side's memberships share a bit with the other's filter, the default) or `'or'` (either way; used only when both colliders ask for it, and a mixed pair tests by `and`). A collider left at its default is in every group. `collider.interactionGroups()` and `solverInteractionGroups()` read them back, and scene queries take either form as `groups`. `contactFilter(a, b)` runs inside the step for each candidate pair of bodies: it may read the world and must not change it, so a step run from it throws, and false lets the pair pass and keeps its sensor events quiet. A body of higher `dominance` is a wall to a dynamic body of lower dominance, in contacts only, and floors still hold it. `body.enabled = false` takes a body out of the world: it keeps its pose and speed, nothing wakes it, its touches end and what rested on it falls, and its joints rest until it comes back, awake. `collider.setEnabled(false)` does the same for one collider, which keeps its mass.

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

Each slot also has `curvature`, what the collider's surface is at the point: -1 for a flat face, else the radius of the sphere that fits it there (a ball's or a capsule's radius, the rounding of a rounded shape, the distance to the axis on a cylinder's side, 0 at a sharp corner or edge), whose centre `point - curvature * normal` is fixed in the body. A solver that holds a contact through a step while the body turns holds a face by its plane and a round place from that centre, so its push on the body and on the particle lie on one line.

`physics.softFaceContacts({from, to, thickness, margin, groups}, k, options)` is the same question for the triangles of a soft body, for what its particles cannot meet: a body smaller than the spacing of the particles, or a thin one lying between them, touches the inside of a triangle. Each triangle is nine numbers where its three corners were (`from`) and nine where they end (`to`), thickened by `thickness` on both sides (one for all, or one each); up to `k` contacts a triangle, the deepest first, each a `point` on the collider's surface with the `normal` out of it toward the triangle, the corners' `weights` at the point of the triangle facing it, the `depth` past the thickness, the `velocity` of the surface, `curvature` as above and `t`, the first touch of a moving triangle (found by conservative advancement on the GJK distance, Mirtich 1996, so a fast sheet does not pass a thin body). Half spaces are left out (a corner is always the deepest point of a triangle under a plane, which the particles meet), as are sensors; `options` are `softContacts'`.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null, {gravity: [0, 0, 0]});
// A 1 cm bead 1.5 cm over the middle of a triangle 20 cm across: no corner reaches it, the triangle does.
physics.addBody(null, {type: 'fixed', position: [0, 0.015, 0], colliders: {shape: 'sphere', radius: 0.01}});
physics.step();
const corners = [-0.1, 0, -0.1, 0.1, 0, -0.1, 0, 0, 0.12];
const faces = physics.softFaceContacts({from: corners, to: corners, thickness: 0.01, margin: 0.01}, 1);
console.log(faces.normal.slice(0, 3), faces.depth[0], faces.weights.slice(0, 3), faces.curvature[0]);
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

A `contactModifier` in the `Physics` options is a contact modification hook: it is called, each step, for every touching pair that has a collider with `modifyContacts: true`, after the pair's friction and bounce are set and before it is solved. It may change `contact.friction`, `contact.restitution` and `contact.normal` (world space, from `contact.first` to `contact.second`), keep a word with the pair in `contact.userData` (0 when the pair is made, lasting as long as the pair does), move a point with `contact.point(k)` (`anchorA` and `anchorB` from each body's centre of mass in its frame, and `distance`, which moves the point on the second body along the normal so a larger distance lets go and a smaller one presses harder), call `contact.clear()` to drop the pair's contacts for the step, set `contact.surfaceVelocity` (world space, a conveyor: friction brings the sliding of the second collider's surface against the first's to it, for this step), or `contact.oneWay(platform, direction, angle)` to keep only the contacts whose normal, taken from the platform to the other collider, is within `angle` (a quarter turn by default) of `direction`. The object is reused: do not keep it. Rapier's JavaScript has no such hook, so the root entry refuses `modifyContacts`. `contactFilter` (above) remains the pair filter for contacts and intersections.

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

Two builds of the kernel ship, each a chunk of its own that loads on first use: one with Wasm SIMD and a scalar one for engines that cannot compile it (older Safari and some embedded webviews). `Physics.load()` probes the engine and loads the one it can run, so a page downloads one of them and the root entry pays for neither; `Physics.load({simd: false})` forces the scalar build (to test it) and `Physics.kernelVariant` reads `'simd'` or `'scalar'`. They are one kernel: both carry the same build id and step a world to the same bits, which the replay test holds on the committed hashes in both builds. The scalar build takes its square roots from integer arithmetic that matches the hardware instruction bit for bit, as Wasm without SIMD has no float square root in Rust's core; it is slower, never different.

A world is one block of memory, so a snapshot is one copy. `world.snapshot()` returns its bytes and `world.restore(bytes)` puts every row, pair and timer back, into a world of any size. A snapshot reads only in the kernel build that wrote it, and it covers the `KernelWorld`; `physics.takeSnapshot()` and `physics.restoreSnapshot()` (see Snapshots) take a whole `Physics` the same way, keeping your handles, `userData` and meshes.

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

`lengthUnit` (option and property, default 1) is Rapier's length unit: the number of your units to a metre-scale, 100 for a world in centimetres. The solver's tolerances (the contact reach `predictionDistance`, `allowedPenetration`, the push-out speeds `contactMaxPush` and `jointMaxPush`, and the sleep speed) are scaled by it, so a world built in centimetres with gravity `-981` plays out as the metre world does; give gravity, sizes and masses in the same unit yourself. `maxCcdSubsteps` (default 1) turns continuous collision off for the whole world when 0; the one pass the solver takes resolves a body's whole sweep, so 2 or more is the same as 1. `physics.timing` reads how long the phases of the last step took in milliseconds (`step`, then `begin`, `broad`, `narrow`, `islands`, `solver`, `ccd` and `events`, which add up to `step`); the clock is not part of the world, so a snapshot and the hash do not see it. `physics.counts` reads what work the last step did as whole numbers that do not depend on the machine: `awake`, `islands`, `pairs`, `pairsLookedAt`, `pairsSolved`, `contactsSolved`, `jointsSolved`, `impacts`, `events` and `steps`. `physics.forEachActiveBody(visit)` visits the bodies the last step worked on: awake dynamic bodies and moving kinematic ones, never sleepers or fixed bodies. `userData` rides on bodies and colliders (an option and a property), and an event hands the same objects back.

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

A generic joint takes `coupled` axes, Rapier's `coupled_axes`: `coupled: ['linY', 'linZ']` with `limits: {linY: [0, 0.5]}` keeps the anchor within 0.5 m of the joint's X axis (a rod in a round hole), and `coupled: ['angY', 'angZ']` with `limits: {angY: [0, 0.5]}` limits the swing across X to 0.5 rad as one angle. `joint.setSoftness(hertz, damping, angular?)` (or the `softness` option) lets a joint's locks give way as springs of their own, per kilogram so a light body and a heavy one sag alike by g over (2 pi hertz) squared; `angular` gives the turning locks theirs, so `setSoftness(0, 1, {hertz: 2})` is a pin that turns like a spring, and `0` makes a group rigid again. A motor takes `frequency` and `dampingRatio` in place of `stiffness` and `damping`. `joint.setDamping(c)` and `joint.setFriction(f)` put a drag (c times the speed) or dry friction (at most f) on a hinge or slider.

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

### Snapshots

`physics.takeSnapshot()` copies the whole world (every body, collider, joint, contact, warm start and sleep timer) and `physics.restoreSnapshot(snapshot)` puts it back, as Rapier's `takeSnapshot`, so stepping on gives the same bits as the first time. The snapshot holds the kernel's rows, not your objects: handles, `userData`, meshes, controllers and listeners stay as they are, and a restore needs the same bodies, colliders and joints to exist, or it throws and changes nothing.

```js
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [10, 0.5, 10]}});
const ball = physics.addBody(null, {position: [0, 3, 0], colliders: {shape: 'sphere', radius: 0.3}});
const before = physics.takeSnapshot();
for (let i = 0; i < 60; i++) physics.step();
const landed = ball.position[1];
physics.restoreSnapshot(before);
for (let i = 0; i < 60; i++) physics.step();
console.log(ball.position[1] === landed); // true: the same run again
```

### Debug lines

`physics.debugRender(options)` returns debug-render data (`style` recolours each kind of line and sizes the contact normal and the body axes, `axes: true` draws each body's three axes, `solverContacts: true` the points the solver pressed after the modifier, and `pseudoNormals: true` the ghost-collision normals of `fixInternalEdges` meshes and height fields (at each triangle, shared edge and vertex); for soft bodies `softBodies.debugRender({ edges, stress, particles, contacts })` draws edges, colours them by strain, and shows particles and contact normals): `vertices` (x, y, z, two vertices a segment) and `colors` (r, g, b, a a vertex) for the outlines of every collider (all shapes, a compound by its parts, a mesh by its edges, a voxel grid by its box), a line across each joint with a line from each anchor to its body (dark red once broken), and each contact point of the last step with a short line along its normal. `boxes: true` adds the world box of each collider; `colliders`, `joints` and `contacts` switch their lines off; `filter` takes a query filter (kind and sensor flags, `exclude`, `groups`, `predicate`) and draws only the colliders it sees, their contacts, and the joints between bodies that are shown. Colours: green awake dynamic bodies, grey fixed, blue kinematic, dim green sleeping, yellow sensors, red joints, magenta contacts, translucent cyan boxes. Draw them with `@margoengine/lines`.

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

A multibody reads where one link would be with `forwardKinematics(body, coordinates?)`, a point's Jacobian with `bodyJacobian(body, point?)`, the joints to a body with `kinematicBranch(body)`, and moves its coordinates by `applyDisplacements(deltas)`; a `kinematicPosition` body in `links` is a kinematic link that `setCoordinates` drives, `coupleDofs(physics, multibody, linkA, linkB, {ratio})` holds one link's coordinate (a hinge's angle or a slider's offset, at any depth) plus `ratio` times another's, on a row of the two links and their parents, and `inverseKinematics` takes `constrain: {position, rotation}` masks for the world axes that count, and keeps every hinge and slider inside its limits and a ball joint (a generic joint with `coupled: ['angY', 'angZ']`) inside its swing cone and its twist range. It reads its tree with `numLinks`, `attachedBodies()`, `linkIndex(body)`, `bodyAt(index)` and `jointBetween(a, b)`, and `multibody.selfContacts = false` makes no two bodies of the tree touch (the default, true, leaves each joint's own `contactsEnabled` to decide for the pair it holds).

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

### Mesh files as colliders

`@margoengine/physics/meshfiles` reads binary and ASCII STL files, Wavefront OBJ files and Collada (DAE) files (faces of any size are fanned, indices may be negative) with no other package: `parseSTL(file)`, `parseOBJ(file)` and `parseDAE(file)` (Collada 1.4: triangles, polylists and polygons, the nodes' matrices, `unit` and `up_axis` applied) give a welded `{vertices, indices}`, and `meshFileCollider(file, {format, shape})` gives collider options, a `trimesh` by default (for fixed bodies) or the `convexHull` of the points (for dynamic ones). `Physics.kernelBuild` is the hash of the kernel source the loaded solver was made from, to record beside a replay.

```ts
import {Physics} from 'margoengine/physics';
import {meshFileCollider} from 'margoengine/physics/meshfiles';

await Physics.load();
const physics = new Physics(null);
const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1\nv 1 0 1\nv 1 1 1\nv 0 1 1\n' +
  'f 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 3 4 8 7\nf 2 3 7 6\nf 4 1 5 8\n';
const crate = physics.addBody(null, {position: [0, 2, 0], colliders: {...meshFileCollider(obj, {shape: 'convexHull'}), density: 100}});
console.log(crate.mass > 0, Physics.kernelBuild.length); // true 64
physics.dispose();
```

### More world settings

`physics.setSolver` also takes `warmStartJoints` (the share of each joint impulse carried from one step to the next, 1 by default), `maxLinearSpeed` (one linear speed cap for every dynamic body, 0 for none, a lower cap on a body still wins) and `staticContactHertz` with `staticContactDamping` (a stiffness of their own for contacts with a fixed or kinematic body; 0 leaves them with `contactHertz`). `physics.wakeUpAll()` wakes every sleeper.

The rest of Rapier's integration parameters that the solver takes are `setSolver` options too, with the same names or near them: `frictionInBiasPass` (default `true`: friction is solved in the pushing passes as well as the relaxing ones; Rapier's default is the opposite, friction only in the unbiased pass, cheaper and kinder to tall stacks; with no relaxing pass friction is solved in the pushing one whatever this says), `internalStabilizationIterations` (Rapier's `num_internal_stabilization_iterations`: how many relaxing passes a substep makes; `null`, the default, is as many as pushing passes, and a count set here is every island's), `frictionModel` (`'coulomb'`, the default, a cone at each contact point; `'simplified'`, Rapier's cheaper model, one constraint for the manifold at the mean of its points and a twist about its normal limited by the loads and their spread), `minCcdDt` (seconds, default 0: an advance of the continuous-collision sweep shorter than this is not taken, and the sweep stops at the time it has reached, which is before any touch), `ccdTolerance` (metres, default 0.001: how close the sweep brings a piece before it stops) and `ccdMaxAdvances` (default 64), and `quarantine` (default `false`): a body whose position or speed leaves the numbers (past 1e15, or not a number) is taken out of the world, at rest where its last good step ended, `physics.on('quarantine', ({body}) => ...)` tells which and `physics.quarantined` lists them, and the world steps on, in place of stopping with a `failed` error. The broad phase and the contact parameters follow: `broadPhase` (`'sweep'`, sweep and prune over the fat boxes, the default, or `'bvh'`, a dynamic tree of them, Rapier's `BroadPhaseBvh`; both find the same pairs, and changing it keeps the pairs the world has), `bvhBuildStrategy` (`'incremental'`, the default, `'binned'` or `'ploc'`: how colliders that join together are built into the tree), `bvhOptimizationStrategy` (`'none'` or `'rotations'`), `adaptiveChangeDetectionMargin` (a fat box's margin an eighth of its smallest side, at most half a metre, where that is over the prediction distance; default false), `contactRecycling` with `contactRecycleDistance` (a pair keeps its manifold while its bodies stay within that distance, 0.05 m by default; a recycled contact is stale by up to it) and `contactClustering` with `contactClusteringAngle` (the points of the parts of a mesh or compound pair in one plane are reduced to four; 0.1 radians by default). `physics.addFreeCollider(options)` adds a collider that belongs to no body of yours (world coordinates; `collider.parent` is null, `collider.free` true) and `physics.removeBody(body, {keepColliders: true})` leaves a removed body's colliders in the world at the poses they had; `body.joints()` lists the joints that hold a body; `kernel.handle('body' | 'collider' | 'joint', row)` makes a generational handle and `kernel.isLive(handle)` or `kernel.assertLive(handle)` refuse one whose row was freed since. `physics.detectCollisions()` is Rapier's collision pipeline: it runs the broad and narrow phases and fires the events of what began or ended touching, with no step of dynamics (nothing moves, speeds and impulses wait, sleepers sleep on), and `physics.timing` also reads the solver's `assembly`, `resolution`, `update` and `writeback` and the sweep's `ccdBroad`, `ccdToi` and `ccdSolver`.

`blockSolver` (default `true`) solves the two to four normal rows of a contact manifold together, Rapier's block solver and what `Physics2D` does too: the loads that meet every point's conditions at once (none negative, none pulling, the points that press holding the gap shut) are found by trying which points are free, at zero or at their cap, in place of sweeping the points one at a time. Four points of one plane give the even split of the load, and a manifold no assignment settles to rounding goes to the sweeps. Friction is still solved a point at a time. `blockSolver: false` sweeps the points one at a time, as releases before 1.0 did. The sweeps can meet a stop with one point held and the body turning about it, an equally valid answer of the same inequalities: a frictionless cube a wall stops at 6 m/s is thrown 0.115 m up at the default 8 substeps and 2 passes, where the block solve holds it to its rest height (docs/limits.md).

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.setSolver({blockSolver: false});
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [20, 0.5, 20]}});
const box = physics.addBody(null, {position: [0, 0.5, 0], colliders: {shape: 'box', halfExtents: [0.5, 0.5, 0.5]}});
for (let i = 0; i < 120; i++) physics.step();
console.log(physics.solver.blockSolver, Math.abs(box.position[1] - 0.5) < 0.01); // false true
physics.dispose();
```

`adaptiveSubsteps` (default `true`) lets each island step at its own level of substeps: 2^k times the world's, k chosen every step from the island's own state, and never finer than 7,680 substeps a second (128 at a 1/60 s step). An island takes the least level at which no body in contact turns more than 0.5054 rad in a substep and the piles standing in it get contacts stiff enough not to tip; the rest of the world steps as before, to the bit. So a 30-row pyramid at one pass a substep rests at either gravity, and a bar spinning at 2,000 rad/s against a wall with friction gains no energy. The cost is that island's work times 2^k: a small body spun to thousands of rad/s while it touches a cluster puts the cluster at the finest level for as long as it spins. `false` holds every island at the world's substeps, the fixed stepping of earlier releases.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
console.log(physics.solver.adaptiveSubsteps); // true
physics.setSolver({adaptiveSubsteps: false});
console.log(physics.solver.adaptiveSubsteps); // false
physics.dispose();
```

`islandMajor` (default `true`, deprecated) solves a step island by island, each through all its substeps, in place of all islands phase by phase. Phase by phase steps every island at the world's substeps, so it has the limits `adaptiveSubsteps` lifts, and it gives the same bits as island by island only with `adaptiveSubsteps: false`: islands share no body a solve changes, and a kinematic platform that two islands rest on is read by each at the pose of the substep it is at.

Migration: `islandMajor: false` is deprecated and phase by phase is removed in `@margoengine/physics` 2.0.0. Leave `islandMajor` unset; for the old fixed stepping set `adaptiveSubsteps: false`, which island by island gives with the same bits phase by phase did.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.setSolver({adaptiveSubsteps: false});
console.log(physics.solver.islandMajor, physics.solver.adaptiveSubsteps); // true false
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
| Additional internal PGS iterations per body (`additional_pgs_iterations`) | `additionalPgsIterations` | full | `next-bodies.test.js` |
| Maximum linear and angular velocity per body | `maxLinearSpeed`, `maxAngularSpeed` | full | `next-speed-caps.test.js` |
| Sleep thresholds, can sleep, put to sleep, wake up | `sleepThreshold`, `sleepTime`, `canSleep`, `sleep`, `wakeUp` | full | `next-sleep-thresholds.test.js`, `kernel-sleep.test.js`, `next-bodies.test.js` |
| Enabled flag | `enabled` | full | `next-dynamics.test.js` |
| Continuous collision detection | `ccd` | full | `next-ccd.test.js` |
| Islands | island forest, an island sleeps together | full | `kernel-sleep.test.js`, `next-bodies.test.js` |
| Integration parameters: step length, substeps, solver iterations | `fixedTimestep`, `substeps`, `iterations` | full | `frames.test.js`, `next-physics.test.js` |
| Integration parameters: contact stiffness and damping ratio, joint stiffness, maximum corrective velocity, allowed linear error, warm starting share | `setSolver` | full | `next-parameters.test.js`, `kernel-solver.test.js`, `next-joint-share.test.js` |
| Integration parameters: prediction distance, length unit, maximum CCD substeps | `predictionDistance` (`tests/next-prediction.test.js`), `lengthUnit`, `maxCcdSubsteps` (`tests/next-parameters.test.js`) | full (a value above 1 of `maxCcdSubsteps` is the same as 1: the one pass resolves a whole sweep) | `next-prediction.test.js` |
| Step timing counters | `timing` | full for 3D: the step, its seven phases, the solver's four and the sweep's three; `Physics2D` has none | `next-parameters.test.js` |
| Integration parameters: friction in the bias pass, internal stabilization iterations, friction model, minimum CCD time step, quarantine | `setSolver` | full | `world-parameters.test.js` |
| `CollisionPipeline`: contacts and events with no dynamics | `detectCollisions` | full | `detect-collisions.test.js` |
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
| Coupled axes of a generic joint, softness of a joint's locks, joint damping and friction | `coupled`, `setSoftness`, `setDamping`, `setFriction`, motor `frequency` | full | `next-joint-coupled.test.js`, `next-joint-softness.test.js`, `next-multibody-kinematics.test.js` |
| Multibody forward kinematics of one link, Jacobian, branch, displacements, kinematic links, IK masks | `forwardKinematics`, `bodyJacobian`, `kinematicBranch`, `applyDisplacements`, `constrain` | full | `next-multibody-kinematics.test.js` |
| World settings: joint warm start share, world speed cap, static contact stiffness, wake all | `setSolver`, `wakeUpAll` | full | `next-world-settings.test.js` |
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

### Robots from URDF and MJCF files

`@margoengine/physics/robots` builds the robot of a URDF or MuJoCo MJCF file in a `Physics`. `addURDF(physics, text, options)` and `addMJCF(physics, text, options)` make a body for each link or body (collision shapes or geoms as colliders, the inertial as the body's mass, centre of mass and inertia) and a joint for each joint (fixed, revolute, continuous, prismatic and floating in URDF; hinge, slide, ball and free in MJCF, with their axes, ranges and damping), held as one multibody (the default) or, with `joints: 'impulse'`, as ordinary joints. Both formats are z up, so the robot is turned to y up unless you pass `upAxis: 'y'`; `position`, `rotation`, `scale` (a file in other units), `fixBase`, `friction` and `collisionGroups` place and set it up, and `loadMesh(filename, scale)` turns a mesh geometry into collider options (without it the geometry is left out and listed in `robot.skipped`). It returns the bodies and joints by the names the file gave them, so you can drive a joint's motor by name. Not read: effort and velocity limits, joint friction, `mimic`, planar joints, and in MJCF default classes, actuators, tendons, contacts and sensors; a body with two MJCF joints is refused with what to do.

```js
import {Physics} from 'margoengine/physics';
import {addURDF} from 'margoengine/physics/robots';

await Physics.load();
const physics = new Physics(null);
const urdf = `<robot name="pendulum">
  <link name="post"><collision><geometry><box size="0.2 0.2 0.2"/></geometry></collision></link>
  <link name="arm">
    <inertial><origin xyz="0 0 -1"/><mass value="1"/><inertia ixx="0.001" ixy="0" ixz="0" iyy="0.001" iyz="0" izz="0.001"/></inertial>
    <collision><origin xyz="0 0 -0.5"/><geometry><cylinder radius="0.03" length="1"/></geometry></collision>
  </link>
  <joint name="hinge" type="revolute"><parent link="post"/><child link="arm"/><axis xyz="1 0 0"/><limit lower="-3.2" upper="3.2"/></joint>
</robot>`;
const robot = addURDF(physics, urdf, {fixBase: true, position: [0, 2, 0]});
robot.bodies.get('arm')!.setRotation([0, 0, 0, 1]); // swing it out level
for (let i = 0; i < 60; i++) physics.step();
console.log([...robot.bodies.keys()].join(), robot.joints.has('hinge')); // post,arm true
```

### The solver contract (`@margoengine/physics/world`)

`@margoengine/physics/world` holds the contract every solver of the physics framework is built on ([docs/physics-framework.md](../../docs/physics-framework.md), section 5): a `Solver` says what it is (`describe()`: the fields it reads, writes or accumulates, its preferred rate level and its stability limit as a function of its state), allocates its state in regions a `SolverHost` gives it (`init`), steps (`step(context, dt)`, a pure function of its state, its input ports, `dt` and its random counter), publishes and gathers ports (`exportPorts`, `importPorts`), and names the regions of its state and its extra history (`stateRegions`, `extraState`), which the world alone snapshots, restores and hashes; a `read` marked `optional` is one the solver does without (no port in its inputs) while no solver writes the field, where a field nobody writes is otherwise refused; a strongly coupled solver adds `iterate` and `rollback`. A `Region` is a stretch of the world's shared memory (byte offset, length, element type, layout version) and a `Port` is a field's region at a tick, with the `Cell` (an integer origin cell of a large world) its positions are expressed in; a step's `StepContext` carries the solver's own cell, and moving an origin changes only these integers. A solver exports a port for every field it writes or accumulates into: a contributor hands its contribution over through its own port, summed by contributor id and then by element. Rates are dyadic: a solver steps at `rateOf(level)` = 60 times 2 to the level steps a second, level 0 to 7, so two coupled solvers meet on every tick of the slower and the faster takes `substepsBetween(fast, slow)` steps per coupling interval. Allocating may grow the world's memory, which detaches every typed-array view over it (any solver's), so a solver takes its views after it allocates and makes them afresh at each use, never holding one across steps: a solver added to a running world grows the memory under the others. The field registry below keeps the fields between them, and `PhysicsWorld` drives them.

```ts
import {Arena, rateOf, substepsBetween, type Region, type Solver, type SolverHost} from 'margoengine/physics/world';

// A ball falling under the world's gravity, its height and speed in one f64 region.
class Fall implements Solver<{height: number}> {
  private state!: Region;
  private host!: SolverHost;
  describe() {
    const height = {name: 'ballHeight', kind: 'scalarSeries', quantity: 'height', unit: 'm', centring: 'particle'} as const;
    return {id: 'fall', fields: [{field: height, access: 'write'}] as const, rate: 2, stableRate: () => 2 as const} as const;
  }
  init(host: SolverHost, params: {height: number}) {
    this.host = host;
    this.state = host.allocate('ball', 16, 'f64', 1);
    this.words()[0] = params.height;
  }
  private words() {
    return new Float64Array(this.host.memory.buffer, this.state.byteOffset, 2);
  }
  step(_context: unknown, dt: number) {
    const w = this.words();
    w[1] += this.host.gravity[1] * dt;
    w[0] += w[1] * dt;
  }
  exportPorts(tick: number) {
    return [{field: 'ballHeight', region: this.state, tick, cell: [0, 0, 0] as const}];
  }
  importPorts() {}
  stateRegions() {
    return [this.state];
  }
  extraState() {
    return [];
  }
  height() {
    return this.words()[0];
  }
}

const arena = new Arena();
const host: SolverHost = {
  memory: arena.memory,
  gravity: [0, -9.81, 0],
  allocate: arena.allocate.bind(arena),
  resize: arena.resize.bind(arena),
  free: arena.free.bind(arena),
  port: () => undefined,
};
const fall = new Fall();
fall.init(host, {height: 10});
const level = fall.describe().rate; // 240 steps a second
for (let tick = 0; tick < rateOf(level); tick++) fall.step({tick, level, seed: 1, inputs: new Map(), cell: [0, 0, 0]}, 1 / rateOf(level));
console.log(rateOf(level), substepsBetween(level, 0), fall.height().toFixed(2)); // 240 4 5.07
```

`stateHash(memory, solvers)`, `takeSnapshot(memory, solvers)` and `restoreSnapshot(memory, solvers, bytes)` work on any set of solvers through the regions they name ([docs/physics-framework.md](../../docs/physics-framework.md), section 8). The hash is 16 hex digits over every byte of each solver's state and extra regions with their names, element types, layout versions and lengths, solvers taken by id and regions in the order listed, so equal states hash equal wherever their regions lie and however the world holds its solvers, and scratch a solver does not name never counts. A snapshot is those bytes under a versioned manifest with the hash, and has no memory offsets in it: it restores into the same solvers laid out anywhere. Restoring checks the encoding version, the solver ids, every region's name, type, layout version and length, and the bytes against the hash before writing anything, and refuses with a coded `MargoError` (`version`, `state` or `failed`) leaving the state as it was. A `Region` may name the `memory` it lies in when that is not the world's: a transitional field for the rigid and soft kernels, each still its own Wasm instance until the framework's solvers share one memory, removed then; the stream records nothing of it, so a hash does not change when the memory does. `physics.kernel.stateRanges()` gives the rigid kernel's state as byte ranges of `physics.kernel.memory`: exactly the words `physics.kernel.hash` covers (the header's scalars and every column but scratch), so the framework's hash over them and the kernel's own move together.

```ts
import {restoreSnapshot, stateHash, takeSnapshot, type Region} from 'margoengine/physics/world';

// One solver's state: a single f64 in the world's memory.
const memory = new WebAssembly.Memory({initial: 1});
const height: Region = {name: 'height', byteOffset: 0, byteLength: 8, type: 'f64', layout: 1};
const ball = {
  describe: () => ({id: 'ball', fields: [], rate: 0, stableRate: () => 0 as const}) as const,
  stateRegions: () => [height],
  extraState: () => [],
};
const value = new Float64Array(memory.buffer, 0, 1);
value[0] = 10;
const saved = takeSnapshot(memory, [ball]);
value[0] = 3; // the run goes on
restoreSnapshot(memory, [ball], saved.bytes);
console.log(value[0], stateHash(memory, [ball]) === saved.hash); // 10 true
```

The field registry (`FieldRegistry`, [docs/physics-framework.md](../../docs/physics-framework.md), section 4) holds every field that crosses a solver boundary: its kind, quantity, SI unit and centring, its one owner, its readers and the solvers that add to it. `declare(solver, uses)` takes what a solver's `describe()` lists and refuses a second writer, a field described two ways, or a known quantity in a unit other than its SI one (`QUANTITY_UNITS`: velocity in `m/s`, impulse in `N s`, temperature in `K`, and so on). `publish(solver, port, level)` copies an owner's port (its positions in `port.cell`, which the world sets) into one of two mirror regions that swap, so readers see the value at the coupling tick however often the owner steps after it, and the previous value stays for interpolation (`field(name).current` and `.previous`, each a port with its tick and origin cell, and its rate level). A contributor's port is added as f64 into a region of its own, and `sum(field, tick)` adds those by contributor id, then by element, into the field's sum region: the same bits whatever order the solvers ran in. All of it lies in regions of the world's memory (`Arena` allocates them, 8-byte aligned and zeroed), and `stateRegions()` lists them, so the state hash and a snapshot carry the registry with the solvers. `TransferRegistry` holds the framework's transfers between representations by name.

```ts
import {Arena, FieldRegistry, regionWords, type FieldDescriptor} from 'margoengine/physics/world';

const impulse: FieldDescriptor = {name: 'hullImpulse', kind: 'bodySet', quantity: 'impulse', unit: 'N s', centring: 'particle'};
const arena = new Arena();
const fields = new FieldRegistry(arena);
fields.declare('ship', [{field: impulse, access: 'write'}]);
fields.declare('sail', [{field: impulse, access: 'accumulate'}]);
fields.declare('waves', [{field: impulse, access: 'accumulate'}]);

// Each contributor publishes its push on the hull; the order they come in does not matter.
for (const [id, push] of [['waves', 120.5], ['sail', 40.25]] as const) {
  const region = arena.allocate(`${id}Push`, 8, 'f64', 1);
  regionWords(arena.memory, region)[0] = push;
  fields.publish(id, {field: 'hullImpulse', region, tick: 0, cell: [0, 0, 0]}, 0);
}
const total = fields.sum('hullImpulse', 0)!;
console.log(regionWords(arena.memory, total.region)[0]); // 160.75
```

`RandomStream(seed, solverNumber(id))` gives a solver counter-based random numbers: Philox4x32-10 (Salmon et al. 2011), the one generator of the framework and word for word the kernels' Rust `Random` (both are pinned to the same vectors). A draw is a pure function of the world's seed, the solver, the tick, the element and a stream, so a solver gets the same numbers whatever order it visits its elements in, on any number of threads and after a restore. `uniform(tick, element, stream)` is a number in [0, 1) with 53 random bits, `unitF64` two of them, `unitF32` four with 24 bits (exact in f32), `below(tick, element, stream, n)` four whole numbers under `n`, and `block` the four raw words; `philox(c0, c1, c2, c3, k0, k1)` is the function itself. `solverNumber(id)` is the whole 32-bit FNV-1a hash of the id, the same in every world (a hundred solvers meet in 32 bits about once in 900,000 worlds, and a world refuses two with one number). The key of the generator is [seed, solver number] and its counter [element, stream, tick low word, tick high word]; the world's seed is one unsigned 32-bit word (0 to 4294967295), and a larger one is refused.

```ts
import {RandomStream, solverNumber} from 'margoengine/physics/world';

const random = new RandomStream(7, solverNumber('spray'));
const a = random.uniform(120, 3); // tick 120, element 3
const b = random.uniform(120, 3);
console.log(a === b, a >= 0 && a < 1); // true true
```

`PhysicsWorld` runs solvers on one clock and one memory ([docs/physics-framework.md](../../docs/physics-framework.md), sections 2 and 5). `world.add(solver, params, cell)` declares the solver's fields in the world's registry, calls its `init` with a host over the world's memory, picks its rate level (the faster of its preferred `rate` and its `stableRate()`) and publishes its ports. The world reads film time from a `FilmClock` of `@margoengine/math/clock` (`clock`, shared with the rest of a scene, or one it makes at `rate`, default 24 frames a second; NTSC as `{num: 24000, den: 1001}`), the one implementation of frame-to-tick arithmetic in the engine: `world.advance(frame)` seeks the clock to frame `frame` (plus `{offset}`, a fraction of a frame for motion blur) and runs every step owed, and `world.advance()` runs to wherever the scene has put the clock. Time is counted in base ticks of 7,680 Hz, `clock.ticks(7680)`, exact in integers, so the same shot at 24, 30 or 60 frames a second is the same physics. On each tick the solvers due run in coupling order (groups of the coupling graph in data order, ids within a group): each takes the sums of what others added to its fields (`host.port`), imports, steps with its readers' ports in `context.inputs`, and exports. A solver's ports include those of the fields it accumulates into. `{maxTicks}` caps one call and `world.settle()` runs the rest, so nothing is dropped; a frame before the world's time is refused (restore a snapshot to go back). Levels are chosen again from each solver's state at every 1/60 s boundary, where every level meets. `world.alpha(level)` is where the clock's time lies between steps of a level, for drawing. A restore puts back the world's state but not the clock, which is the scene's; the next `advance(frame)` seeks it. The clock, the levels, the origin cells and the registry lie in the world's memory with the solvers' state, so `world.hash()`, `world.takeSnapshot()` and `world.restoreSnapshot(bytes)` cover all of it and a restored run goes on bit for bit. Solvers that push on bodies (the rigid, soft, air, hull, ship, entry and deck-water solvers) share the world's body rows, `world.bodyRows`: the records of every body-set field, fixed by the rigid solver from its kernel's capacity when it is added, or by the world's `bodyRows` option; add the rigid solver first, or make the world with `{bodyRows: physics.kernel.capacity}`. For large worlds each solver steps in the frame of an origin cell of `cellSize` metres (default 4,096), its `context.cell`, which the world also sets on every port it publishes: `shiftOrigin(delta)` moves every cell by whole numbers and changes no simulated state, and `relocate(offset, fromCell, toCell)` moves a position through the exact cell difference. `RandomStream` is Philox4x32-10 (Salmon et al. 2011) keyed by the world's seed and `solverNumber(id)` and counted by tick, element and stream, so a draw is a pure function of those.

```ts
import {PhysicsWorld, regionWords, type Region, type Solver, type SolverHost} from 'margoengine/physics/world';

// A mass on a spring stepped 240 times a second (rate level 2), publishing its height.
let host: SolverHost, state: Region, port: Region;
const spring: Solver = {
  describe: () => ({
    id: 'spring',
    rate: 2,
    fields: [{field: {name: 'height', kind: 'scalarSeries', quantity: 'height', unit: 'm', centring: 'particle'}, access: 'write'}],
    stableRate: () => 2,
  }),
  init(h) {
    host = h;
    state = h.allocate('state', 16, 'f64', 1);
    port = h.allocate('height', 8, 'f64', 1);
    regionWords(h.memory, state)[0] = 1;
  },
  step(_context, dt) {
    const s = regionWords(host.memory, state);
    s[1] -= 40 * s[0] * dt;
    s[0] += s[1] * dt;
  },
  exportPorts(tick) {
    regionWords(host.memory, port)[0] = regionWords(host.memory, state)[0];
    return [{field: 'height', region: port, tick, cell: [0, 0, 0]}]; // the world sets the cell to the solver's
  },
  importPorts() {},
  stateRegions: () => [state],
  extraState: () => [],
};
const world = new PhysicsWorld({rate: {num: 24, den: 1}}).add(spring, {});
world.advance(24); // one second: 240 steps of 1/240 s
const height = world.fields.port('height')!;
console.log(world.time, height.tick, regionWords(world.memory, height.region)[0].toFixed(3)); // 1 239 0.999
```

`world.couple(ids, scheme, options)` sets how a coupling group (solvers that feed each other) exchanges data within a tick ([docs/physics-framework.md](../../docs/physics-framework.md), section 5); solvers not coupled exchange `'staggered'`, each stepping in coupling order (ids within a group) and publishing at once; a `'staggered'` coupling steps its members in the order `ids` gives, so `world.couple(['soft', 'rigid'], 'staggered')` steps soft before rigid, whatever order they were added in. `'strang'` takes two solvers, the first stepping two half steps around the second's whole one (one rate level above it). `'predicted'` steps every member on the others' values extrapolated linearly to its step's end, then publishes them all. `'implicitPressure'` steps the members that own bodies, then the member that adds to their fields (the solve that takes the bodies in), and the bodies take its impulses in the same tick. `'iterated'` re-runs the group's tick `iterations` times (default 4) on shared values moved between runs by Anderson acceleration (`accelerator: 'anderson'`, `depth` 5) or Aitken's relaxation (`'aitken'`, `relaxation` 0.5); every member needs `iterate()`, and the count is fixed, so the result is the same bits on every machine. Every scheme but `'staggered'` needs `ids` to be exactly one coupling group, and its members step at one level (the fastest any of them chooses). With `bodyMass` and `addedMass` (the added-mass coefficient times the fluid's density times the displaced volume) a scheme that exchanges once a tick is refused where the added mass would make it diverge: `staggeringStable(bodyMass, addedMass, margin = 2)` is that test. `world.schemeOf(id)` says how a solver is coupled. The coupling-test harness (`packages/physics/tests/coupling/harness.js`) holds a solver or a coupling to the framework's properties: `frameRateIndependent`, `seekEqualsContinuous`, `conservesMomentum`, `energyNeverRises`, `effectBothWays`, `orderSensitivity` and `addedMassStable`; `npm run check:coupling` (part of `verify`, so of `check:merge`) refuses a framework solver that no test in a `tests/coupling/` folder runs through it.

```ts
import {staggeringStable, Anderson} from 'margoengine/physics/world';

// A 1 kg balloon of 1 litre in water: 0.5 kg of added mass (a sphere's), so plain staggering would diverge.
console.log(staggeringStable(1, 0.5 * 1000 * 0.001)); // false
console.log(staggeringStable(7.85, 0.5 * 1000 * 0.001)); // true: a steel ball of the same size

// Anderson acceleration on its own: the fixed point of x = 3 - 1.5 x, which plain iteration never reaches.
const anderson = new Anderson(1, 2);
const x = new Float64Array([0]);
for (let k = 0; k < 4; k++) anderson.next(x, [3 - 1.5 * x[0]], x);
console.log(x[0].toFixed(6)); // 1.200000
```

`RigidSolver` puts a `Physics` in a `PhysicsWorld` as the framework's rigid solver: `world.add(new RigidSolver(), {physics})`. Each of its steps is the Physics's own `step()`, so its bodies, colliders, joints, queries, events and attachments work as before and a world steps it to the same bits as calling `step()` alone. It owns three fields:
- `bodies`, a body set of `BODY_WORDS` (25) f32 per kernel body row, published at each coupling tick: the origin's position (0-2), the rotation (3-6), the centre of mass (7-9), the linear (10-12) and angular (13-15) velocity, the inverse mass (16), the inverse inertia in world axes as its six distinct entries xx, xy, xz, yy, yz, zz (17-22), 1 for a moving body (23), and the substeps its last step took (24; the world's `substeps` times 2^k for its island's level, 0 for a body that does not move). A force held through a step of s substeps moves a body by (v + F dt (s + 1) / (2 s m)) dt, so a solver that holds a load from a body's pose takes it (s - 1) / (2 s) of the step on, where the load neither feeds the motion nor drains it.
- `bodyImpulses`, which other solvers accumulate into: `IMPULSE_WORDS` (6) numbers per body row, a linear impulse in N s and an angular impulse about the body's centre of mass in N m s, world axes. A load at a point p is the pair (J, (p - c) x J) with c the centre of mass from `bodies`: pairs add, so the world sums the contributions by contributor and then by element, and the rigid solver applies the sum at the start of its next step. (A point and an impulse would not add.)
- `bodyForces`, which other solvers accumulate into the same way: `FORCE_WORDS` (6) numbers per body row, a force in N and a torque about the centre of mass in N m, world axes. The rigid solver adds the sum to the bodies' forces for its next step only and takes off exactly what they took after it, so a push held over a step (a cloth holding a box up, a hull's load) acts through the step and leaves nothing behind.

Migration: a world steps at the framework's rates, so the Physics's `fixedTimestep` must be one of them (1/60, 1/120, 1/240 ... 1/7680 s); any other is refused with a `RangeError` that names the nearest two (`rateLevelOf(step)`). The kernel's state is the words its own hash covers, named by column and row capacity (`positionX[1024]`), with the scratch columns it carries from one step into the next as extra state, in the kernel's own memory until the framework's solvers share one. The Physics's `stepCount` is extra state too (one f64 region, `stepCount`), so a seek by `restoreSnapshot` rewinds the clock that winds, sails and `Physics.advance` read as `stepCount * fixedTimestep`; the Physics takes the restored count at the world's next step. A snapshot restored into a world built with other capacities or another column table is refused before anything is written, with every region that does not fit named in the message.

`SoftSolver` puts the `SoftBodies` of that `Physics` in the world: `world.add(new SoftSolver(), {soft})`, coupled soft before rigid with `world.couple(['soft', 'rigid'], 'staggered')`, so the soft step meets the bodies where the tick began and its push lands in that tick's rigid step, as inside `Physics.step()`. Added to a world, the Physics attachment's own soft step does nothing, so nothing steps twice, and a world steps a scene to the same bits as `step()` alone. It reads `bodies` and accumulates into `bodyImpulses` and `bodyForces`: each push on a body is an impulse at the start of the rigid step, its spin change as the angular impulse that gives it through the body's inertia there, and a force held over that step. `Physics.step()` alone hands the bodies the same numbers through the body API and takes the force off at the end of the step. Its state is every soft kernel column but those a step builds afresh (its contacts and the table of the bodies they meet), in the kernel's own memory, so a restored world goes on bit for bit; a snapshot restores into the same soft bodies.

```ts
import {Physics} from 'margoengine/physics';
import {SoftBodies, SoftBodyDesc} from 'margoengine/physics/soft';
import {PhysicsWorld, RigidSolver, SoftSolver} from 'margoengine/physics/world';

await Physics.load();
const physics = new Physics(null, {fixedTimestep: 1 / 60});
const soft = await SoftBodies.attach(physics);
soft.create(SoftBodyDesc.cloth([-0.35, 1, -0.35], [0.1, 0, 0], [0, 0, 0.1], 8, 8).setPinnedParticles([0, 7, 56, 63]));
const box = physics.addBody(null, {position: [0, 1.3, 0], colliders: {shape: 'box', halfExtents: [0.08, 0.08, 0.08], mass: 2}});
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(new SoftSolver(), {soft})
  .couple(['soft', 'rigid'], 'staggered');
world.advance(60); // one second
console.log(physics.stepCount); // 60: each solver stepped once a tick
console.log(box.position[1] < 1.3); // true: the box came down onto the cloth
```

`AirSolver` (of `@margoengine/physics/flight`) puts the air's loads on the rigid bodies of that `Physics` in the world: `WindForce`, and `WingForce`, `RotorForce` and `LiftingGas` of `@margoengine/physics/flight`. `world.add(new AirSolver(), {physics})`, coupled air before rigid with `world.couple(['air', 'rigid'], 'staggered')`: the loads meet the bodies where the tick begins and are held over that tick's rigid step, as inside `Physics.step()`, and the Physics's own step leaves them alone, so a world steps them to the same bits as `step()` alone. It accumulates into `bodyForces`, each body's loads summed in the order they were made. `Physics.step()` alone sums them the same way, adds the sum to the body's force and torque for the step, and takes off exactly what they took after it, so a body keeps its own `addForce` to the bit when a wind stops. The loads read the bodies through their Physics (their colliders, mass and inertia), so a `beforestep` listener that moves a dynamic body acts after them in a world and before them alone. It has no state: each step's loads come from where the bodies are, the air and the time, which in a world is the world's tick, so a restored world samples a gust where it did before. `SailForce` is not among them: it loads a cloth's particles, which the `SoftSolver` steps.

```ts
import {Physics} from 'margoengine/physics';
import {AirSolver, RotorForce} from 'margoengine/physics/flight';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
const physics = new Physics(null, {fixedTimestep: 1 / 60});
const drone = physics.addBody(null, {position: [0, 5, 0], colliders: {shape: 'box', halfExtents: [0.3, 0.05, 0.3], mass: 2}});
const rotor = new RotorForce(physics, drone, {radius: 0.3, blades: 2, chord: 0.03, pitch: 0.2, speed: 400});
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(new AirSolver(), {physics})
  .couple(['air', 'rigid'], 'staggered');
world.advance(60); // one second
console.log(rotor.thrust > 19.6, drone.position[1] > 5); // true true: the rotor out-pulls the 2 kg drone's weight and it climbs
```

### The terrain bed (`@margoengine/physics/earth`)

One grid of ground elevations that erosion, slides and craters change and that colliders, water and hooves read (PA-37). `TerrainBed` is the framework solver that owns the field `bed`: it keeps the elevations in f64, adds each tick what writers accumulated into the field `bedChange` (metres of change a vertex, summed by contributor id then vertex, so the result is the same bits whatever order the writers were added in), keeps the bed above an optional bedrock, and publishes the elevations as f32. Its ledger holds the volume writers asked for and the volume the bedrock refused, so `volume() - startVolume = requestedVolume() + refusedVolume()`. `bedVertexAreas` gives each vertex's area exactly for the triangulation, so a writer that removes a volume here and puts it there conserves it. The grid is laid out as the kernel's height field (rows along z, columns along x, column major) and cut into the same triangles, so `Bed.sample`, a kernel ray and a contact see one surface. `BedCollider` puts the bed in a `Physics` world as a height field and `sync(bed)` writes the changed heights into the field's own memory (`PhysicsCollider.setHeights`): editing the ground every step allocates nothing, and what rests on it wakes, so a ball on ground that a crater opens under falls in.

```ts
import {Physics} from 'margoengine/physics';
import {BedCollider, bedSurface} from 'margoengine/physics/earth';

await Physics.load();
const physics = new Physics(null, {gravity: [0, -9.81, 0]});
const grid = {columns: 8, rows: 8, width: 16, depth: 16, centre: [0, 0] as [number, number]};
const heights = new Float32Array(9 * 9); // flat ground at 0 m
const ground = new BedCollider(physics, bedSurface(grid, heights));
const ball = physics.addBody(null, {position: [0, 0.5, 0], colliders: {shape: 'sphere', radius: 0.5}});
for (let i = 0; i < 60; i++) physics.step();
heights[4 + 9 * 4] = -2; // a pit under the ball
console.log(ground.sync(bedSurface(grid, heights))); // 1: one height moved
for (let i = 0; i < 120; i++) physics.step();
console.log(ball.position[1] < 0); // true: it fell in
console.log(bedSurface(grid, heights).sample(0, 0).elevation); // -2
```

### Clouds: moist convection (`@margoengine/physics/clouds`)

`CloudSolver` is the physics framework's clouds (ATMO-03): a box of air over flat ground in which warm, moist air rises, cools, condenses into cloud, releases its latent heat, rains and drifts with the wind. Add it to a `PhysicsWorld` with its settings: the box (`cells`, default 48 by 24 by 48, of `cellSize` metres, default 200, about `centre` over `ground`), the environment (the standard atmosphere at `altitude` with `seaLevelTemperature`, default 298.15 K, and relative `humidity` from 0.75 at the ground to `humidityTop` 0.3 at the top), the ground's `surfaceHeat` and `surfaceLatent` heat (W/m^2, defaults 250 and 150, varying by `patchiness` from place to place each `thermalPeriod` so thermals rise in some places and not others), warm `bubbles` to start from, the `wind` that carries air through the box, and `timeScale`, the seconds of cloud time per second of world time (60 runs a minute of weather a second, for a timelapse); the cloud steps every `interval` seconds of its own time (default 2). It publishes `cloudWater` (kg/kg per cell) as a registry field, `cloudWater()` copies it as a density volume for the sky to draw (x fastest, then up, then z), `sample(x, y, z)` gives the cloud and rain water, vapour, temperature and velocity anywhere in the box, `rainRate(x, z)` the rain reaching the ground in mm/h, `rainSource()` that rain as a `source` for `PrecipitationField` (`@margoengine/weather/precipitation`), and `windWith(base)` a wind with the clouds' own updrafts and outflow added. Physics after Harris et al. (2003), with Kessler's warm rain; whether rain reaches the ground as snow is the precipitation field's to decide from the air there.

```ts
import {CloudSolver} from 'margoengine/physics/clouds';
import {PhysicsWorld} from 'margoengine/physics/world';

const clouds = new CloudSolver();
const world = new PhysicsWorld({rate: {num: 24, den: 1}}).add(clouds, {
  cells: [16, 16, 16],
  cellSize: 100,
  humidity: 0.9,
  humidityTop: 0.8,
  surfaceHeat: 0,
  surfaceLatent: 0,
  bubbles: [{centre: [0, 400, 0], radius: 500, warming: 3, humidity: 1.05}],
  timeScale: 120, // two minutes of weather a second
});
world.advance(24); // one second of film
console.log(clouds.time, clouds.cloudWater().some((q) => q > 1e-5)); // 120 true: a cumulus after two minutes
console.log(clouds.sample(0, 800, 0).velocity[1] > 10); // true: its updraft, over 10 m/s
```

### Sea waves: a spectral wave model (`@margoengine/physics/waves`)

`WaveSolver` is the physics framework's sea waves (SEA-01): a third-generation spectral wave model, the energy balance of WAM as SWAN states it, on a grid of the water. Wind seas grow with fetch and duration, swell runs in from the open sea at its group velocity and decays slowly, and waves feel the bottom and break where the water is shallow. The physics: by default the ST4 wind input and dissipation of Ardhuin et al. (2010), as WAVEWATCH III states them (Janssen's input with the waves' own stress feeding back on the sea's roughness, swell damped by the air, breaking from the spectrum's saturation), with Cavaleri and Malanotte-Rizzoli's linear growth, the discrete interaction approximation of the quadruplets, JONSWAP bottom friction, Battjes and Janssen depth breaking, and the Hersbach and Janssen action limiter. `physics: 'wam3'` swaps in WAM Cycle 3's Komen input and whitecapping. Waves travel by the third-order ULTIMATE QUICKEST scheme, so a wind sea grows along its fetch as measured, without the smearing of a first-order scheme. Its settings:

- the grid: `cells`, default 32 by 32, of `cellSize` metres, default 1000, about `centre`;
- the water: `depth` (a number or a function of (x, z), 0 or less for land) or a terrain `bed` under `waterLevel`, and `density` (1025 for the sea, `FRESH_WATER_DENSITY` 1000 for a lake);
- the `wind` over it, any framework `Wind`, sampled 10 m above the water;
- the spectrum: `frequencies` (default 0.04 to 1 Hz in 34 steps) and `directions` (default 24);
- the sea: a JONSWAP `swell` coming in over the open edges, a `start` sea, and `periodic` edges for a sea that goes on the same way;
- time: `interval` (the sea's own step, default 60 s), `timeScale`, and `warmUp`, seconds of sea run before the shot so the sea is already up;
- `physics`: `'st4'` (default) or `'wam3'`.

**How well it grows.** Every ST4 constant is the WAVEWATCH III manual's TEST471 set except the sheltering of the short waves `s_u`: the manual gives 0.3 for TEST471 today and 1 for TEST471 before 2012 and for TEST500. It was calibrated the way the wave-modelling community tests fetch growth (Liu et al. 2019): against Kahma and Calkoen's stable fetch law in friction-velocity scaling, e* = g^2 E / u*^4 = 2.1e-3 chi*^0.79 with chi* = g x / u*^2, at 10 and 20 m/s, on a grid that resolves the coast. 1 fits best (rms of ln(e* / law) 0.108 at 10 m/s and 0.046 at 20 m/s; 0.125 and 0.099 at 0.3); the roughness cap makes no difference and stays TEST471's. Checked on what was not fitted: at 30 m/s rms 0.038 and a slope of chi*^0.76; in U10 scaling at 10 m/s the height is within 14 percent of Hwang's fetch law and JONSWAP's over chi = g x / U^2 of 1,000 to 10,000; with unlimited fetch, run to g t / U10 = 2.5e5, the developed sea is 0.221 U10^2 / g at 10 m/s and 0.281 at 20 m/s, against Alves, Banner and Young's 0.254 (band 0.233 to 0.272), its peak within 6 percent of their 0.123 g / U10. Pierson and Moskowitz's often-quoted 0.21 is in the wind at 19.5 m (0.241 in U10). ST4's input scales with u*, so the developed sea rises with the wind more than the data show (a ratio of 1.27 from 10 to 20 m/s against their 1.02), as Rogers et al. (2012) note of this family, and it keeps growing slowly rather than stopping (Ardhuin et al. 2010). **Resolve the coast:** fetch growth converges with the grid, and a coarse grid near a shore spreads the young waves' fast growth over too long a fetch. Take cells of g dx / U^2 of about 60 or less over the first part of the fetch; at 250 the law flattens to chi^0.63 and short fetches run 40 percent high in energy at 20 m/s. Keep `interval` at 120 s or less: at 300 s the action limiter starts to shape the growth. It costs about 4.6 ms a cell-step in TypeScript, five times WAM Cycle 3. `waves.frictionVelocity(x, z)` gives the wind's u* over the water there, from the waves' own roughness with ST4 (a young sea drags harder): the stress on the sea is rho_a u*^2.

It publishes the spectrum E(f, theta) of every cell as the registry field `waveSpectrum`. `waves.field` is the framework's `WaveSpectrumField`, which the sea surface synthesises its waves from. `significantHeight(x, z)` and `peakPeriod(x, z)` summarise a place. `wavenumber`, `groupVelocity`, `jonswap`, `significantHeight` and `peakFrequency` work on any spectrum.

```ts
import {FRESH_WATER_DENSITY, WaveSolver} from 'margoengine/physics/waves';
import {PhysicsWorld} from 'margoengine/physics/world';
import {BoundaryLayerWind} from 'margoengine/weather/boundary-layer';

// A gale of 18 m/s across a deep lake, from its western shore, ten hours in.
// The wind and depth are uniform across the lake, so one periodic row represents the same fetch.
const wind = new BoundaryLayerWind({speed: 18, turbulence: false});
const waves = new WaveSolver();
new PhysicsWorld({rate: {num: 24, den: 1}}).add(waves, {
  cells: [20, 1],
  cellSize: 4000,
  centre: [40000, 0],
  periodic: ['z'],
  depth: 60,
  density: FRESH_WATER_DENSITY,
  wind,
  warmUp: 10 * 3600,
});
console.log(waves.significantHeight(5000, 0).toFixed(1), waves.significantHeight(75000, 0).toFixed(1)); // 1.6 3.2: higher with fetch
console.log(waves.peakPeriod(75000, 0).toFixed(1)); // 7.0 s at 75 km
const spectrum = waves.field.sample(75000, 0); // 34 frequencies by 24 directions, fresh water: what the sea surface reads
console.log(spectrum.frequencies.length, spectrum.directions.length, spectrum.density); // 34 24 1000
```


### The sea's surface and the water below it (`@margoengine/physics/sea`)

`SpectralSea` is the sea-surface contract of `@margoengine/math/fields` (`SeaSurface`, SEA-02): a pure, synchronous query
of the sea, the same bits on every machine, so a hull, a fish, kelp and spray read one sea. It sums one linear wave per
frequency and direction bin of a wave spectrum (the wave solver's `WaveSpectrumField`, or one spectrum such as `jonswap`
gives), each with the amplitude its energy gives, a phase from the seed, and the wavenumber of the finite-depth dispersion
relation.

- `sample(x, z, t)`: the surface's height, normal, velocity (the waves' orbital motion plus the current), the current,
  the still-water depth and the water's density.
- `water.sample(x, y, z, t)`: the water's velocity at any depth, falling off as cosh(k (y + D)) / sinh(k D) (e^(k y) in
  deep water), plus the current; above the surface or below the bottom there is no water (density 0).
- `elevation(x, z, t)` and `pressure(x, y, z, t)` (hydrostatic plus the waves' dynamic pressure, 0 at the surface): the
  `SeaQuery` the hull solver reads, so `new HullSolver()` takes `{sea}` as it is.
- `refresh()` reads the spectrum again as the wave solver grows it; every wave keeps its phase, so the sea changes smoothly.
- `current`: any flow field of water (a tide, a river) added to the waves; `density` comes with the spectrum (1000 fresh,
  1025 sea).

```ts
import {SpectralSea} from 'margoengine/physics/sea';
import {jonswap} from 'margoengine/physics/waves';

const spectrum = {
  frequencies: Float64Array.from({length: 34}, (_, i) => 0.04 * 25 ** (i / 33)),
  directions: Float64Array.from({length: 24}, (_, j) => (2 * Math.PI * j) / 24),
  energy: new Float64Array(34 * 24),
  depth: 30,
  density: 1025,
};
jonswap({height: 2, period: 8, direction: 0}, spectrum); // a 2 m sea running toward +x
const sea = new SpectralSea({waves: spectrum, seed: 1});
const surface = sea.sample(10, 0, 3.5);
console.log(Number.isFinite(surface.height), surface.normal[1] > 0); // true true
console.log(sea.water.sample(10, 6, 0, 3.5).density); // 0: no water 6 m above the still level
console.log(sea.pressure(10, -20, 0, 3.5) > 1025 * 9.81 * 19); // true: about 20 m of water above
```

### Wakes: the water a hull pushes (`WakeSolver`, `@margoengine/physics/sea`)

`WakeSolver` is SEA-04: the local free surface a hull disturbs, on a grid around the ship, stepped by the world. Each
Fourier mode of the surface is advanced exactly over a step, with the finite-depth dispersion of water waves (omega^2 =
g k tanh(k D)), driven by the pressure and displaced volume its `sources` put on the water at each step's time (a hull's
weight over its waterplane as `SeaSource`s). So the wake's shape comes from the physics alone: transverse waves 2 pi U^2 / g
long behind a hull at speed U, inside the Kelvin wedge at a Froude number under about 0.5, narrowing at higher ones as
Rabaud and Moisy (2013) observed. A border of `sponge` cells absorbs what reaches the edge. Its height and potential are
world state (snapshot, restore, hash). `sample(x, z)` gives the wake's height, slope and surface velocity; pass the solver
to `SpectralSea` as one of its `patches` and the sea's `sample`, `elevation` and `pressure` carry it, so a hull floats on
its own wake and on the ships around it.

```ts
import {SpectralSea, WakeSolver} from 'margoengine/physics/sea';
import {PhysicsWorld} from 'margoengine/physics/world';

const wake = new WakeSolver();
const world = new PhysicsWorld({rate: {num: 30, den: 1}}).add(wake, {
  cells: [128, 64],
  cellSize: 1,
  // A hull 12 m long at 4 m/s: 0.3 m of water's weight on its waterplane.
  sources: (t) => [{x: -40 + 4 * t, z: 0, radius: 6, pressure: 1025 * 9.81 * 0.3, volume: 0}],
});
world.advance(10 * 30); // ten seconds
console.log(wake.sample(-10, 0).height !== 0); // true: the wake behind the hull
const spectrum = {frequencies: Float64Array.from([0.1, 0.2]), directions: Float64Array.from([0, Math.PI]), energy: new Float64Array(4), depth: Infinity, density: 1025};
const sea = new SpectralSea({waves: spectrum, patches: [wake]});
console.log(sea.elevation(-10, 0, 10) === wake.sample(-10, 0).height); // true: a calm sea carries the wake
```

### A hull on the sea (`@margoengine/physics/seakeeping`)

`HullSolver` is the water's load on rigid hulls (SEA-08), for the physics framework's rigid solver.
- **Each step:** it reads where each hull's body is from the `bodies` port, and integrates the water's pressure over the wetted part of the hull's surface, taken where the held load neither feeds the motion nor drains it (see **The load each step**). It then holds the body with that force, and its moment about the centre of mass, over the rigid step through `bodyForces`.
- **The hull** is a closed triangle mesh in the body's frame, wound outward. Each triangle is cut where the sea's surface crosses it (the linear cut, then two secant steps on the surface). The wet pieces are integrated by Dunavant's six-point rule, which is exact for the hydrostatic force and moment.
- **The sea** is the framework's sea surface, `SpectralSea` from `@margoengine/physics/sea` (the wave solver's spectrum as a sum of waves; measured: in its long swell a box rides up and down within 0.04 percent of the frequency-domain answer), made in the hull solver's origin cell (another cell is refused, naming the fix); or anything with `elevation(x, z, t)`, and optionally `pressure(x, y, z, t)`: the hydrostatic pressure plus the waves' dynamic pressure, stretched to 0 at the surface (Wheeler). Without it, the water is still to its local surface, rho g (eta - y). The pressure over the instantaneous wetted surface is the nonlinear Froude-Krylov load. `density` is the sea's, default sea water.
- **`wettedLoads(mesh, pose, sea, t, about)`** gives the same force, moment and wetted area for one hull at one instant.
- **Measured:**
  - a box at its draft is held up by the weight of the water it displaces, to f64 rounding;
  - heeled, a box rights itself by the wall-sided righting arm;
  - in a small wave, a box takes the linear Froude-Krylov heave load;
  - a section's Lewis form matches the book's container section, and its added mass meets the exact limits of a half circle and of flat plates;
  - a heaving half circle's damping from the pressure equals that from its waves, and meets its limits at high and low frequency;
  - a swaying and rolling section's damping from the pressure equals that from its waves, its couplings are reciprocal, and a half circle rolling about its centre makes no waves;
  - driven, a box heaves within 0.6 percent of the frequency-domain answer at 60 steps a second, and let go it settles at its damping;
  - driven sideways, a box sways and rolls within 1.1 percent of the coupled frequency-domain answer at 60 steps a second;
  - on a hull uneven fore and aft, heave drives pitch with the phase the strips' coupling gives it, within 1.2 percent;
  - held up by its buoyancy alone, a hull heaves and rolls on at the amplitude it was let go at (within 1 percent over 8 cycles);
  - let go heeled 15 degrees, the box Jung, Chang and Jo measured (2006) rolls down with a decay coefficient 7.7 percent under theirs and a period 3.2 percent short (its added roll inertia from potential flow is less than the measured), nothing fitted.
- **The water a hull carries:** its added mass at infinite frequency, from its sections under the waterline it floats at each step (strip theory). Each section is mapped to its Lewis form, and its heave added mass is integrated to the hull's heave and pitch; its sway and roll added mass at infinite frequency come from the radiation solution below (the free surface makes it smaller than the rigid-lid value `swayAddedMassRigidLid`, which is the zero-frequency limit). The solver holds M (M + A)^-1 (F + W + E) - W - E, so the body moves as hull and water together, stable even when the water outweighs a light hull. E is every other load on the body (a tow, the wind, a sail, a contact), seen from its last two steps. `addedMass: false` leaves it out; `stations` sets the sections (default 24); `gravity` must be the rigid world's. `hullSections`, `lewisForm` and `addedMassInfinite` are exported to inspect it.
- **The waves a hull makes:** its heave, pitch, sway, roll and yaw damping and their couplings, with memory (Cummins 1962).
  - Each section's damping at each frequency comes from Ursell-Tasai's multipole solution on its Lewis form: `heaveSection` in heave, `lateralSection` in sway and roll about the centre of mass (and their coupling). The damping is computed twice, once from the pressure on the hull and once from the energy of the waves it sends out, and the two agree.
  - The damping is integrated along the hull at its still-water draft (`hullMemory`), turned into the radiation kernel K(t), and convolved with the hull's motion over the last `memory` seconds (default 20).
  - A hull let go settles, and a hull driven at a frequency heaves as the frequency-domain equation of motion says. `radiation: false` leaves it out.
- **Roll's viscous damping:** the eddies a rolling hull sheds at its bilges and the friction of its skin, which potential flow leaves out and which damp a real hull's roll most near its resonance (Ikeda's component method, ITTC 7.5-02-07-04.5). Each section's eddy coefficient (`eddyRollCoefficient`) and skin friction (`frictionGirth`, Kato's laminar law at the hull's natural roll frequency) are integrated along the hull about its centre of mass, and the moment -(eddy |p| + friction) p, p the roll rate, is taken implicitly in the damping, so a light hull stays stable. `rollDamping: false` leaves it out; `viscosity` is the water's kinematic viscosity (default `SEA_VISCOSITY`, 1.19e-6 m^2/s, sea water at 15 degrees C; fresh water 1.14e-6). Bilge keels, skegs and forward speed are not in yet.
- **The load each step** is taken where a load held through the rigid step neither feeds the motion nor drains it: (s - 1) / (2 s) of the step on, s the substeps the `bodies` port gives (7/16 at 8), the pose carried there by the body's velocity and spin. Taken at the middle, a hull lost about pi w dt / (2 s) of its amplitude a cycle; taken where the step starts, it gained energy. The radiation force, convolved up to the step's start, is carried to the same point along its last two values.
- **The waves a hull turns:** their diffraction, by strip theory's relative motion principle (Journee and Massie eqs. 8.19 and 8.45-8.47). Each section takes its added mass times the water's acceleration and its radiation memory convolved with the water's velocity, as it takes them for its own motion, at the depths that stand for its motion: its mean draft in heave and its centroid's depth in sway and roll. The Froude-Krylov part is the pressure over the wetted surface. It needs a sea that gives the water's motion (a `SeaSurface`'s `water`, as `SpectralSea`'s does); `diffraction: false` leaves it out. Measured: in head seas a box heaves within 1 percent of strip theory's frequency-domain answer (82 to 267 percent off without the diffraction); held in beam seas, its sway force and roll moment are within 1.5 percent.
- **The waves' drift:** the mean and slowly varying push of the waves a hull sends back. Each section's far-field drift in beam waves is the momentum the waves carry, 1/2 rho g a^2 |R|^2 per metre (Maruo; a wall sending everything back takes 1/2 rho g a^2), R the wave it sends back while it moves as the hull does (`scatterSection`, the two-dimensional scattering derived from the radiation solution). The solver applies it less the part its Froude-Krylov pressure over the moving wetted surface already gives, across the hull, over the sea's waves by Newman's approximation (the mean and the slow beat of wave groups). It needs a sea that gives its waves (`SpectralSea`'s `waveComponents`); `drift: false` leaves it out. Measured: moored in beam waves, a box's mean offset holds the far-field drift within 3 percent of the wall's force, and in short waves the wall's itself.
- **Green water:** the sea coming over the deck, after Zhang and Reed (2024): shallow water on each hull's deck (`deckOf`, the mesh's upward-facing top above its still waterline, on a grid of `deckCells`, default [32, 12]) in the deck's moving frame (`stepDeck`: Rusanov's flux with Audusse's hydrostatic reconstruction, so a lake on a sloped deck stays still and cells dry). Where the sea stands above a deck edge it comes aboard as a dam breaks (Ritter's critical flow at the edge), and where it does not the deck water runs off at the brink. The deck water's weight, rho G h with G the deck's effective gravity, loads the hull, and the deck's own faces then take no Froude-Krylov pressure, so the water over them is counted once. What comes aboard is published in the `deckInflow` port for a liquid solver on the deck; where one owns a hull's on-deck load (`deckClaims` 1), the hull solver leaves its own out. `greenWater: false` leaves it out. Measured: a dam on the deck breaks within 1.1 percent of Ritter's solution, the sea comes over a dry edge at Ritter's flux (to 1e-4), and a box held with its deck under water takes the whole submerged box's buoyancy (to 1e-4).
- **Slamming:** a section coming down into the water takes the momentum of the water it sets moving, (dm/dh) V^2 a metre (von Karman 1929), m the added mass of its wetted width with the water's pile-up (Wagner 1932: the wetted half-breadth c solves the mean of the section's height over c sin(theta) equal to its depth), V its speed into the water; past a chine or knuckle the flow leaves the hull and the impact ends. Each station's table comes from the mesh's sections (`slamStations`, `slamSlope`). `slamming: false` leaves it out. Measured: a 30 degree wedge entering at a steady speed takes Wagner's force within 0.02 percent until its chine is wet.
- **Flooding:** a damaged hull's compartments taking in the sea and spreading it, the air they drive out or trap, the cargo they lose and the list, trim and loss of buoyancy that follow (`compartments` and `openings` on a hull; `Flooding` runs the same on its own). Each compartment is a closed mesh in the body's frame with its `permeability` (default 0.95; machinery 0.85, cargo 0.6 to 0.7, SOLAS II-1 regulation 7-3), its floodwater's surface level square to gravity, so it runs to the low side as the hull heels. Water flows through an opening (a breach, door, hatch, vent or pipe: a rectangle with its centre, normal, width and height) by Bernoulli's equation with a discharge coefficient (default 0.611, a sharp-edged hole), from the pressures on its two sides at each height, its air's and its water's head; an opening part under water and part in the air takes the weir's flow. Each compartment's air keeps its mass, at Boyle's pressure, so a compartment with no vent above its water keeps a pocket of air that stops the sea and floats an upturned hull; it leaves through vents and the dry part of a breach, and bubbles out under water. An opening can open and shut at given times (`opens`, `closes`) or give way under a head of water (`collapse`, a hatch cover or window). Backward Euler on the compartments' water and air keeps every level between its neighbours' at any step. The floodwater is added weight at its centre and moves with the hull in the added-mass solve. A hold's cargo (`cargo`: iron ore, coal, grain, sand, silt, dye or oil, its mass part of the body's) pours out through a breach under its top, by Beverloo's law dry and by Wilson et al.'s under water, while the sea is not coming in. What leaves through each opening to the outside is published in the `hullBreaches` port, for the tracers (the cargo) and the foam (the air). Measured: a box filling through a hole follows Torricelli's law within 6e-4 m of 1.5 m at 60 steps a second (first order in the step); a half-submerged side opening takes the weir's flow to 1e-12; an unvented box stops the sea where Boyle's law says (to 1e-9 m); a barge holed in a wing tank comes to rest at the lost-buoyancy equilibrium within 0.0002 degrees of heel and 0.04 mm of sinkage.
- **Form drag:** each wet piece facing the way the hull moves through the water takes the stagnation pressure 1/2 rho C (v . n)^2 (Newton's impact law of drag; `dragCoefficient` C, default 1.05, Hoerner's cube face-on), v its velocity relative to the water at the centre of mass, the roll's part left to the roll damping where that is on. It is taken in the share the hull has gone under past the displacement it floats at (0 floating, 1 with all of it under): a floating hull's resistance is its surface models' (the waves it makes, its roll's eddies, a manoeuvring model's resistance). It sets the speed a hull that has lost its buoyancy sinks at and how it turns going down. `drag: false` leaves it out. Measured: a box falling flat under the sea comes to the speed where its drag holds its weight less its buoyancy (to 0.1 percent).
- **Not yet:** bilge keels and forward speed in the roll damping, surge added mass, deck structures and bulwarks in the green water, sloshing of the floodwater.

```ts
import {Physics} from 'margoengine/physics';
import {HullSolver} from 'margoengine/physics/seakeeping';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
const physics = new Physics(null, {fixedTimestep: 1 / 60});
// A 4 m by 2 m box, 1.5 m deep, as heavy as 0.5 m of sea water under it: it floats at a 0.5 m draft.
const [L, D, B, T] = [4, 1.5, 2, 0.5];
const box = physics.addBody(null, {
  position: [0, D / 2 - T, 0],
  colliders: {shape: 'box', halfExtents: [L / 2, D / 2, B / 2], mass: 1025 * L * B * T},
});
// The box's surface, twelve triangles wound outward.
const v = [];
for (const x of [-L / 2, L / 2]) for (const y of [-D / 2, D / 2]) for (const z of [-B / 2, B / 2]) v.push(x, y, z);
const mesh = {
  vertices: v,
  indices: [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3],
};
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(new HullSolver(), {hulls: [{row: box.row, mesh}], sea: {elevation: () => 0}})
  .couple(['hull', 'rigid'], 'staggered');
world.advance(60);
console.log(Math.abs(box.position[1] - (D / 2 - T)) < 1e-3); // true: it floats at its draft
```

A barge holed in a wing tank, which floods through the hole while its air leaves by a vent, and lists:

```ts
import {Physics} from 'margoengine/physics';
import {HullSolver} from 'margoengine/physics/seakeeping';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
/** A box from corner a to corner b, twelve triangles wound outward. */
const cuboid = (a: number[], b: number[]) => {
  const v: number[] = [];
  for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) v.push(x, y, z);
  return {vertices: v, indices: [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]};
};
const physics = new Physics(null, {fixedTimestep: 1 / 60});
// A 20 by 4 by 8 m barge floating at a 2 m draft.
const barge = physics.addBody(null, {colliders: {shape: 'box', halfExtents: [10, 2, 4], mass: 1025 * 20 * 8 * 2}});
const hull = {
  row: barge.row,
  mesh: cuboid([-10, -2, -4], [10, 2, 4]),
  // A wing tank on the starboard side, the barge's full depth.
  compartments: [{mesh: cuboid([-5, -2, 2.5], [5, 2, 4])}],
  openings: [
    // A 2 by 0.5 m hole in the side at the bottom, and a vent in the tank's top.
    {from: 0, to: 'outside' as const, centre: [0, -1.5, 4] as const, normal: [0, 0, 1] as const, width: 2, height: 0.5},
    {from: 0, to: 'outside' as const, centre: [0, 2, 3.25] as const, normal: [0, 1, 0] as const, width: 0.3, height: 0.3},
  ],
};
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(new HullSolver(), {hulls: [hull], sea: {elevation: () => 0}, greenWater: false})
  .couple(['hull', 'rigid'], 'staggered');
for (let f = 1; f <= 60 * 60; f++) world.advance(f);
const heel = (2 * Math.asin(barge.rotation[0]) * 180) / Math.PI;
console.log(heel > 13 && heel < 14.5); // true: it lists about 13.7 degrees as the lost buoyancy says
```

On a sea of waves, the framework's `SpectralSea` from a spectrum (here one 1 m swell of 0.1 Hz along x):

```ts
import {Physics} from 'margoengine/physics';
import {SpectralSea} from 'margoengine/physics/sea';
import {HullSolver} from 'margoengine/physics/seakeeping';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
const frequencies = Float64Array.from({length: 34}, (_, i) => 0.04 * 25 ** (i / 33));
const directions = Float64Array.from({length: 24}, (_, j) => (2 * Math.PI * j) / 24);
const energy = new Float64Array(34 * 24);
const bin = frequencies.findIndex((f) => f >= 0.1);
// All the energy in one bin: a wave of amplitude a holds a^2 / 2 over the bin's width in frequency and direction.
energy[bin * 24] = 1 / 2 / (((frequencies[bin + 1] - frequencies[bin - 1]) / 2) * ((2 * Math.PI) / 24));
const sea = new SpectralSea({waves: {frequencies, directions, energy, depth: Infinity, density: 1025}});

const physics = new Physics(null, {fixedTimestep: 1 / 60});
const [L, D, B, T] = [4, 1.5, 2, 0.5];
const box = physics.addBody(null, {
  position: [0, D / 2 - T, 0],
  colliders: {shape: 'box', halfExtents: [L / 2, D / 2, B / 2], mass: 1025 * L * B * T},
});
const v = [];
for (const x of [-L / 2, L / 2]) for (const y of [-D / 2, D / 2]) for (const z of [-B / 2, B / 2]) v.push(x, y, z);
const mesh = {
  vertices: v,
  indices: [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3],
};
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(new HullSolver(), {hulls: [{row: box.row, mesh}], sea})
  .couple(['hull', 'rigid'], 'staggered');
let highest = -Infinity;
for (let frame = 1; frame <= 30 * 60; frame++) {
  world.advance(frame);
  if (frame > 10 * 60) highest = Math.max(highest, box.position[1] - (D / 2 - T));
}
console.log(highest > 0.8); // true: it rides the swell's crests
```
### Into the water and out of it (`EntrySolver`, `@margoengine/physics/entry`)

`EntrySolver` is SEA-14: bodies striking the water, going under, breaking out and falling back, a cannonball, a diver, a
launched hull or a breaching whale, beside the rigid solver (`world.couple(['entry', 'rigid'], 'staggered')`). Give it
each body's row and its closed surface (`mesh`, wound outward, a few hundred to a few thousand triangles) and the water
(`sea`: a `SpectralSea`, so the impact is against the local surface and relative to the waves' own motion, or anything
with `elevation`). Each step it holds the body with:

- the sea's own pressure over the wetted surface (as `HullSolver` takes it), but none over the part inside an open air
  cavity;
- the impact pressure 1/2 rho (U . n)^2 on each face moving into the water (Birkhoff's, which gives the ricochet: a ball
  skips under 18 degrees / sqrt(sigma), Johnson and Reid's critical angle, here within 10 percent of it);
- the slam as it strikes, from Wagner's wetted radius and Korobkin's modified Logvinovich model (a sphere's slam peaks at
  C = 1.02 at 13 percent of its radius in, as Shiffman and Spencer's curve and the experiments of Antolik et al. do);
- the water it carries: the wetted disc's added mass as it strikes, Lamb's spheroid under water, and S. F. Hoerner's
  streamlined drag for a long body under water.

Above Duez et al.'s threshold (7.2 m/s for a wetting surface; `contactAngle` over 90 degrees lowers it) it drags an air
cavity down, which closes under the water's weight depth by depth (Duclaux et al., Aristoff et al.) and pinches: the deep
seal throws a Worthington jet. `splashes()` lists what happened at the water, as events a renderer can draw (Water's
`ShotSplash` draws them): `entry` (with its crown sheet), `seal` (the jet), `exit` (the water lifted as it breaks out),
`skip`. `seaSources()` is the water it moved this step, for a `WakeSolver`'s `sources`, so the entry and the cavity's
collapse make their waves; pass a `FoamSolver` as `foam` for the foam it leaves.

```ts
import {Physics} from 'margoengine/physics';
import {EntrySolver} from 'margoengine/physics/entry';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
const physics = new Physics(null, {fixedTimestep: 1 / 960});
// A 25 mm steel ball dropped in at 9 m/s.
const R = 0.0125;
const ball = physics.addBody(null, {
  position: [0, 0.02, 0],
  linearVelocity: [0, -9, 0],
  colliders: {shape: 'sphere', radius: R, mass: 7850 * (4 / 3) * Math.PI * R ** 3},
});
// Its surface: a UV sphere, wound outward.
const vertices: number[] = [];
const indices: number[] = [];
for (let j = 0; j <= 16; j++)
  for (let i = 0; i <= 32; i++) {
    const th = (Math.PI * j) / 16, ph = (2 * Math.PI * i) / 32;
    vertices.push(R * Math.sin(th) * Math.cos(ph), R * Math.cos(th), R * Math.sin(th) * Math.sin(ph));
  }
for (let j = 0; j < 16; j++)
  for (let i = 0; i < 32; i++) {
    const a = j * 33 + i;
    if (j > 0) indices.push(a, a + 1, a + 34);
    if (j < 15) indices.push(a, a + 34, a + 33);
  }
const entry = new EntrySolver();
const world = new PhysicsWorld({rate: {num: 960, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(entry, {bodies: [{row: ball.row, mesh: {vertices, indices}}], sea: {elevation: () => 0}, level: 4})
  .couple(['entry', 'rigid'], 'staggered');
world.advance(96); // a tenth of a second
console.log(entry.splashes().map((e) => e.kind).join(' ')); // "entry seal": in with a cavity, which pinches
```

### Water that splashes and pours (`FlipSolver`, `DeckWaterSolver`, `@margoengine/physics/flip`)

`FlipSolver` is FLUID-03: water in a box of cells that collapses, splashes, overturns and pours, as APIC particles
(Jiang et al. 2015) on a grid that keeps it incompressible with a free surface (Gibou et al.'s ghost fluid). Give it
the box (`cells`, `cellSize`, `origin`), where the water starts (`initial(x, y, z)`, eight particles a cell), solid
boxes it flows round (`solids`) and the sides open to the air (`open`), where water leaves for the sea
(`seaSources()`, for a WakeSolver). Each world step takes as many substeps as keep every particle within a cell, and after each the particles that cluster are moved apart by Kugelstadt et al.'s implicit density projection, so the water keeps its volume.
`positions()` gives the particles for drawing, `velocityAt` and `pressureAt` read the grid. Martin and Moyce's dam
break is its check: the front within 2 percent of their measurements.

Crashing crests: give a box a `sea` (a `SpectralSea`, or anything with `elevation(x, z, t)` and `water.sample`) and no
`initial`, and it starts as that sea, its water moving as the sea's does. Its four sides then take the sea's own
velocity, and a band of `blend` cells (6) inside them is held to the sea's motion and level (the hybrid of Chentanez,
Muller and Kim 2014). Waves run in and out, and inside the box they are free to steepen, overturn and break. Checked:
a linear wave passes through with its amplitude and phase, and a dispersively focused packet overturns and plunges, its
jet outrunning its crest (`node scripts/check-breaker.mjs`, minutes a run). How much faster is not yet settled: 1.26 to
1.72 times the crest speed across starts and grids, where Erinin et al. (2023) measured 1.24 to 1.33 (docs/limits.md
says why). Cells of 2 cm do not resolve a 15 cm plunger's jet: give a breaking crest a dozen cells.

```ts
import {FlipSolver} from 'margoengine/physics/flip';
import {PhysicsWorld} from 'margoengine/physics/world';

// A regular wave 1 m long and 3 cm high, and a box of it 2 m long.
const [a, k] = [0.03, 2 * Math.PI];
const w = Math.sqrt(9.81 * k);
const sea = {
  elevation: (x: number, _z: number, t: number) => a * Math.cos(k * x - w * t),
  water: {
    sample(x: number, y: number, _z: number, t: number) {
      const e = a * w * Math.exp(k * Math.min(y, 0));
      return {velocity: [e * Math.cos(k * x - w * t), e * Math.sin(k * x - w * t), 0] as [number, number, number]};
    },
  },
};
const box = new FlipSolver();
const world = new PhysicsWorld({rate: {num: 60, den: 1}}).add(box, {cells: [80, 32, 1], cellSize: 0.025, origin: [0, -0.6, 0], sea});
world.advance(30); // half a second of the wave running through it
console.log(box.count > 0); // true
```

`DeckWaterSolver` is green water on a hull's deck: the same liquid in a box riding a rigid body (`row`, `offset` in
the body's frame), feeling the frame's acceleration as the hull heaves and rolls. It takes the sea where it comes over
the bulwarks from the `deckInflow` port, gives water over an open side back to the sea, and holds the hull with the
deck's load through `bodyForces`. It claims its hull in `deckClaims`, so the hull's exceedance solver leaves its own
deck load out.

```ts
import {FlipSolver} from 'margoengine/physics/flip';
import {PhysicsWorld} from 'margoengine/physics/world';

// A column of water 0.3 m wide and 0.6 m high let go in a tank 2 m long.
const water = new FlipSolver();
const world = new PhysicsWorld({rate: {num: 120, den: 1}}).add(water, {
  cells: [80, 32, 1],
  cellSize: 0.025,
  initial: (x, y) => x < 0.3 && y < 0.6,
  rate: 1,
});
world.advance(60); // half a second
let front = 0;
const p = water.positions();
for (let i = 0; i < p.length; i += 3) front = Math.max(front, p[i]);
console.log(front > 1); // true: the surge has run more than a metre
```

### Bubbles in the water (`BubbleSolver`, `@margoengine/physics/bubbles`)

`BubbleSolver` carries the air the water takes in: the cloud and aerated plume behind a ship's stern, or any air you
put in with `sources(t)` (a place, a box and a rate in m^3/s). Air enters split over eight radii from 20 um to 1 mm by
Deane and Stokes' spectrum, as parcels of bubbles that:
- ride the water's flow (`water`, any FlowField: a ship solver's races, a sea's water);
- rise at the speed sea water's surfactants leave them (Thorpe's and Keeling's rigid-sphere formula);
- dissolve by Castro's mass transfer (about 2 min for a 100 um bubble a metre down), swelling as they rise into lower
  pressure;
- lay foam where they surface (`foam`, a FoamSolver's `addFoam`).

`shipAeration(ships)` gives a `ShipSolver`'s air: 10 percent void taken in over 0.1 m where each propeller race boils up
to the surface. Couple the bubbles after the ship, so they read the races where its last step left them:
`couple(['ship', 'rigid', 'bubbles'], 'staggered')`. Read `parcelData()` to draw them, `voidFraction(x, y, z, cell)` for
how white the water is, and `ledger()` for the air taken in, dissolved, surfaced and held.

```ts
import {BubbleSolver} from 'margoengine/physics/bubbles';
import {PhysicsWorld} from 'margoengine/physics/world';

const bubbles = new BubbleSolver();
const world = new PhysicsWorld({rate: {num: 60, den: 1}}).add(bubbles, {
  // A litre a second of air taken in half a metre down, for two seconds.
  sources: (t) => (t < 2 ? [{position: [0, -0.5, 0], width: 0.5, depth: 0.2, rate: 1e-3}] : []),
});
world.advance(240); // four seconds
const air = bubbles.ledger();
console.log(air.surfaced > 0 && air.held > 0); // true: the big bubbles are up, the small ones still rising
```

### Tracers and slicks in water (`@margoengine/physics/tracers`)

`TracerSolver` is the physics framework's tracers (SEA-15): dye, discoloured water, silt and cargo plumes, and oil slicks. Each is a cloud of particles of a material, carried by the water's velocity at its depth (`water`, any `FlowField` of water; still water by default). Turbulence spreads them as a random walk, so a cloud's variance grows as 2 K t (`horizontalDiffusivity`, default 0.1 m^2/s; `verticalDiffusivity`, default 0.001). Grains settle at Ferguson and Church's speed for their size and density and come to rest on the `bed` (a terrain bed, or a depth, default 30 m below `waterLevel`). Floating material stays on the surface and drifts with the water there plus a share of the `wind` (`windage`, default 3 percent). `sources` release a material (one of `TRACER_MATERIALS`: `dye`, `silt`, `sand`, `ironOre`, `coal`, `grain`, `oil`, or your own `{density, diameter, shape, floats, windage, colour}`) at a fixed place or along a path (a breach in a moving hull), at a rate in kg/s that may change with time, between `start` and `stop`. `particleMass` (default 1 kg) sets how fine the cloud is, and `capacity` (default 20,000) how many particles it may hold.

The solver keeps the mass exactly: `budget` gives what was released, what is in the water, on the surface and on the bed, always adding up. `concentration(min, max, cells)` gives the concentration (kg/m^3) on a grid and the colour it gives the water, `particlesOf()` every particle, and the particles are the registry field `tracers` for the sea surface to tint its water. A ship's `wakeTint` (`@margoengine/water`) remains as an art override for a stern trail and is deprecated as the source of discoloured water: release the cargo here instead.

```ts
import {TracerSolver} from 'margoengine/physics/tracers';
import {PhysicsWorld} from 'margoengine/physics/world';

// A hull steaming at 3 m/s through a 0.4 m/s current leaks iron ore from a breach, less as its hold empties.
const water = {medium: 'water' as const, cell: [0, 0, 0] as const, sample: (_x: number, _y: number, _z: number, _t: number, out = {velocity: [0, 0, 0] as [number, number, number], density: 1025, temperature: 285}) => ((out.velocity = [0.4, 0, 0]), out)};
const tracers = new TracerSolver();
const world = new PhysicsWorld({rate: {num: 24, den: 1}}).add(tracers, {
  water,
  bed: 12,
  sources: [{material: 'ironOre', position: (t) => [3 * t, -5, 0], rate: (t) => 40 * Math.exp(-t / 60)}],
});
world.advance(240); // ten seconds
const {released, water: suspended, bed} = tracers.budget;
console.log(released.toFixed(0), (suspended + bed).toFixed(0)); // 368 368: every kilogram in the water or on the bed
const plume = tracers.concentration([-10, -12, -10], [50, 0, 10], [12, 6, 4]);
const cell = plume.mass.findIndex((m) => m > 0);
console.log(Array.from(plume.colour.slice(3 * cell, 3 * cell + 3)).map((c) => c.toFixed(2))); // ['0.55', '0.12', '0.06']: iron-ore red
```

For a ray, enable `bedJets` to couple swimming impulses to the erodible bed. A downward fin impulse spreads
as it reaches the bed. It lifts `sand` (default) or `silt` where its estimated shear passes the critical Shields
number (default 0.05). `erodibility` defaults to 0.02 kg/m²/s at unit excess shear, and `availableMass` defaults
to an unlimited layer. The active parcels drift with `water` and settle at their grain speed. Read `jetErosion`
for kilograms lifted, and `particlesOf()` or `concentration()` for a renderer. The rest of the bed stays solid.
The [rendered coupling fixture](../environment/tests/swim-sediment.html) shows the sand rise, drift, and settle.

```ts
import { SwimSolver } from 'margoengine/physics/life';
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const rays = await SwimSolver.load();
world.add(rays, { bodies: [{
  position: [0, -0.2, 0], length: 1, width: 0.2, height: 0.2, mass: Math.PI * 0.2 * 0.2 * 1025 / 6,
  tail: { amplitude: 0, span: 0.16, wavelength: 0.85 }, wettedArea: 0, steering: [0, 1, 0],
  fins: { area: 0.05, strokeAmplitude: 0.2, strokeFrequency: 1 },
}] });
const sediment = new TracerSolver('sand', { bedJets: true });
world.add(sediment, { bed: 0.5, bedJets: { availableMass: 0.023 } });
world.advance(1);
console.log(sediment.jetErosion > 0, sediment.budget.water > 0); // true true
```

### Rivers, floods and dam breaks (`@margoengine/physics/hydro`)

`ShallowWaterSolver` is the physics framework's water on the ground (HYDRO-01): conservative shallow water over the terrain bed. Water runs downhill over the world's terrain bed (or a bed of its own), wets and dries the ground as it goes, loses speed to Manning's bed friction, and takes in rivers, rain and the wind's drag; a dam breaks, a river finds its normal depth, a wave runs up a beach and leaves it dry again. The scheme is the one `@margoengine/water/flood` runs on the GPU, here on the CPU in f64: Chen and Noelle's hydrostatic reconstruction (a lake stays at rest over any bed, and depths stay at or above 0), the HLL flux with Kurganov and Petrova's speeds, WENO-Z where the water is deep and minmod at shorelines, two-stage SSP Runge-Kutta, and semi-implicit Manning friction, in as many substeps a tick as the Courant bound needs. Every face's flux leaves one cell and enters the next, so the water's volume changes only by what the inflows and rain add and the sides take: to rounding, as `budget` shows. Its settings:

- `bed`: the ground, the world's terrain (`terrain.bed` of a `TerrainBed` added before it, the surface over the elevations it publishes) or a bed of its own (`bedSurface`), read every step, so ground that erosion or a crater changes changes the flood; the water's cells are the bed's, and a cell's bed is the mean over its two triangles, the surface colliders see;
- the water at the start: a `level` (a height, or a function of (x, z): every cell whose bed is lower fills to it) or a `depth`, and a `velocity` function;
- `roughness`: Manning's n in s/m^(1/3), a number or a function of (x, z) (default 0.03, a natural channel; 0.013 concrete, 0.05 to 0.1 floodplain with brush);
- `sides`: `minX`, `maxX`, `minZ` and `maxZ`, each `'wall'` (default), `'open'` (the flow goes on past the edge as it is, over the bed's slope carried on, so a river leaves at its normal depth), `{level}` (a lake or a sea held at a height in metres, or a function of time: a tide, a surge; long waves reflect from it), `{sea}` (the open sea at a height, which lets waves from inside leave: the characteristic coming in is still water at that height's, or with `incoming(t, x, z)` a long wave coming in from outside, [elevation, velocity x, z], such as a surf's `boundWave`) or `'periodic'` with its opposite side (a coast or a channel that goes on the same way);
- `buildings`: `{min: [x, z], max: [x, z], height}` boxes that raise the bed under them (Schubert and Sanders' building blocks), so a flood goes round a town's blocks and over them only when deeper than they are tall;
- `inflows`: rivers and pipes, `{position: [x, z], discharge}` in m^3/s or a function of time (a flood hydrograph);
- `rain`, a `Precipitation` field (`@margoengine/weather`'s `PrecipitationField`), falling on water and ground alike; `wind`, a framework `Wind`, whose stress rho_a C_D |U| U drags the water (Garratt's C_D = (0.75 + 0.067 U) 1e-3, up to `windDragLimit`, default 2.5e-3, where the sea's roughness saturates in storm winds, Donelan et al. 2004);
- `courant` (default 0.4, at most 0.5), `density` (default 1000), `rate` (its rate level, default the world's base rate).

It publishes the field `surfaceWater`: per cell, the depth h in m and the discharges hu and hv in m^2/s, as f32, x fastest. It takes waves' forcing from the field `surfaceWaterForcing`, which a `SurfSolver` adds to: per cell, the force of the radiation stress over the density, the Stokes drift (the water's momentum is then Lagrangian, and its bed friction acts on what is left of it) and the orbital velocity that stirs the bed. `water.sample(x, z)` gives the depth, the surface height and the depth-averaged velocity there; `water.flow` is the water as a framework `FlowField` (for tracers, debris and bodies); `water.volume()` the volume, and `water.budget` what came in by the inflows and by rain and what left over the sides since the start, in m^3.

```ts
import {bedSurface} from 'margoengine/physics/earth';
import {ShallowWaterSolver} from 'margoengine/physics/hydro';
import {PhysicsWorld} from 'margoengine/physics/world';

// A valley 400 m long falling 1 in 100, a reservoir 3 m deep behind a dam at 100 m that has just failed.
const columns = 80, rows = 20, width = 400, depth = 100;
const elevations = new Float64Array((columns + 1) * (rows + 1));
for (let c = 0; c <= columns; c++)
  for (let r = 0; r <= rows; r++) {
    const x = (width * c) / columns, z = (depth * r) / rows;
    elevations[r + (rows + 1) * c] = 4 - 0.01 * x + 0.002 * (z - 50) ** 2; // a V-shaped valley
  }
const bed = bedSurface({columns, rows, width, depth, centre: [200, 50]}, elevations);
const water = new ShallowWaterSolver();
const world = new PhysicsWorld({rate: {num: 30, den: 1}}).add(water, {
  bed,
  level: (x) => (x < 100 ? 6 : -1), // the reservoir; dry below the dam
  sides: {maxX: 'open'},
});
const start = water.volume();
world.advance(30 * 60); // one minute
console.log(water.sample(300, 50).depth > 0); // true: the flood has reached 300 m
console.log(Math.abs(water.volume() + water.budget.out - start) < 1e-6 * start); // true: every cubic metre accounted for
```

### Whitecaps, foam and spray (`@margoengine/physics/foam`)

`FoamSolver` is the sea's foam (SEA-13). The breakers come from the sea's own spectrum: the same saturation that drives ST4's breaking dissipation gives the length of breaking crests per area (Leckler et al. 2013), so the whitecaps match the waves the sea actually has. The solver draws breakers as events on the world's random numbers, at the rate each bin breaks:
- each breaker is a crest 0.3 of a wavelength long, breaking for 0.8 of a period as it moves at the wave's speed;
- it sweeps a strip of white water and leaves residual foam behind;
- small breakers leave faint foam that fades in seconds; storm breakers leave dense foam that trails and lasts longer.

On average the foam covers what Leckler et al.'s ST4 whitecap law gives. 16 percent of it is still breaking, Reul and Chapron's share. The foam is carried by the surface:
- the water's current;
- the waves' Stokes drift;
- 0.6 percent of the wind.

Above 3 m/s Langmuir windrows sweep long-lived foam into lines along the wind. The transport conserves foam and stretches it with the flow's shear instead of smearing it. Ships lay wakes: white water two beams long at the stern, a turbulent wake widening as x^(1/5) for a ship length, and the bow waves' arms at Kelvin's angle once the hull is fast enough. A wake's foam lasts minutes. The spray the whitecaps throw into the air follows Gong's (2003) flux by the whitecap method, with Troitskaya's bag breakup at strong winds.

Its settings:
- `waves`: the sea, a `WaveSolver` (its `field`, and its friction velocity for the spray) or any `WaveSpectrumField`;
- the grid: `cells` (default 128 by 128) of `cellSize` metres (default 2), about `centre`; `statistics`, the spacing at which the spectrum is read for the breakers (default 64 m);
- `wind`, a framework `Wind`, for the wind drift and the windrows; `current`, a water `FlowField` (a river's or a tide's);
- `decay`, residual foam's e-folding time (default 3.8 s in sea water, 2.5 s in fresh, from the sea's density);
- `windDrift` (default 0.006 of U10); `windrows` (`{spacing = 30, speed = 0.01, spinUp = 300}` or `false`);
- `ships`: `{body, length, beam}` or `{track(t), length, beam}`; `wakePersistence` (default 150 s);
- `capacity` (breakers alive at once, default 8192) and `rate` (its rate level).

It publishes the field `seaFoam`: per cell, the foam coverage and the active whitecap coverage, 0 to 1, as f32.
- `coverage(x, z)` and `activeCoverage(x, z)` read one cell; `meanCoverage()` the whole grid; `expectedCoverage(x, z)` is Leckler's law for the sea there.
- `addFoam(min, max, whiteness, persistence)` lays foam from a splash or an impact.
- `spray(x, z, r80)` is the film and jet drop flux in droplets per m^2 per s per micrometre of r80; `bagBreakups(x, z)` is the spume events per m^2 per s.
- `breakingStatistics(spectrum, g)` gives any spectrum's whitecap coverage, breaking crest length, turnover and surface Stokes drift.

```ts
import {FoamSolver} from 'margoengine/physics/foam';
import {WaveSolver} from 'margoengine/physics/waves';
import {PhysicsWorld} from 'margoengine/physics/world';
import {BoundaryLayerWind} from 'margoengine/weather/boundary-layer';

// A 13 m/s wind on a sea that has blown for a day, and a coaster steaming through at 6 m/s.
const wind = new BoundaryLayerWind({speed: 13, turbulence: false});
const waves = new WaveSolver();
const foam = new FoamSolver();
const world = new PhysicsWorld({rate: {num: 30, den: 1}})
  .add(waves, {cells: [1, 1], cellSize: 1e7, periodic: ['x', 'z'], wind, warmUp: 24 * 3600})
  .add(foam, {
    waves,
    wind,
    cells: [96, 96],
    cellSize: 2,
    ships: [{track: (t) => ({position: [-90 + 6 * t, 0], velocity: [6, 0]}), length: 40, beam: 9}],
  });
world.advance(30 * 20); // twenty seconds
console.log(foam.expectedCoverage(0, 0) > 0.005); // true: whitecaps on about 1 percent of the sea
console.log(foam.coverage(-12, 0) > 0.5); // true: the wake behind the coaster's stern
console.log(foam.spray(0, 0, 1) >= 0); // true: droplets per m^2 s um where the foam is
```

### The surf zone (`@margoengine/physics/surf`)

`SurfSolver` brings a sea or a swell ashore over a `ShallowWaterSolver` (SEA-05). The short waves of one representative period travel in, shoal and refract over the bed. They break as the water shoals (Roelvink's dissipation) and hand what they lose to a roller of broken water. The gradient of their radiation stress drives the shallow water:
- it sets down before the breakers and up inside them;
- it runs along the shore as a longshore current;
- it returns seaward as undertow (the bed's friction acts on the water's flow less the waves' Stokes drift);
- it streams out through channels in a bar as rips;
- with `groups`, it surges with the wave groups (surf beat) and runs up and down the beach.

This is the phase-averaged "surfbeat" chain of XBeach (Roelvink et al. 2009). The solver keeps each line's highest run-up and when each cell was last wet, so the wet sand's edge is known. Couple it before the water: `world.couple(['surf', 'water'], 'staggered')`, and give the water an open sea at its offshore side (`sides: {minX: {sea: 0}}`), so the long waves the surf makes can leave. Its settings:
- `water`: the `ShallowWaterSolver`, added to the world first;
- `incident`: the waves coming in, `{height, period, direction, spreading = 10, gamma = 3.3}` (significant height and peak period of a JONSWAP sea) or `{waves}`, a `WaveSpectrumField` (`WaveSolver.field`) sampled at the offshore side;
- `side`, the offshore side they come in over (default `'minX'`), and `alongshore`, `'open'` (default) or `'periodic'` for a coast that goes on the same way (give the water periodic sides there too);
- `groups` (default true): the incoming energy comes in groups, the envelope of the sea's components, so the water answers with surf beat and swash; off, it is steady. Feed the groups' bound long wave to the water's open sea, `sides: {minX: {sea: 0, incoming: (t, x, z) => surf.boundWave(t, x, z)}}`, so the long waves come in with them (Longuet-Higgins and Stewart's zeta_b = (2n - 1/2)(E - mean E) / (rho (c_g^2 - g h)));
- `currents` (default true): the waves ride the water's currents, keeping their absolute frequency and their action flux (c_g + U) E / sigma, refracted by the currents' shear and blocked where c_g + U falls to 0, so rips steepen the waves that meet them;
- `level`, the still water level the set-up and run-up are measured from (default 0);
- `directions` (default 36 over the incoming half-plane, 5 degrees);
- `breaking` (`{gamma = 0.55, alpha = 1, n = 10}`), `roller` (`{beta = 0.1}` or `false`), `density` (default 1025) and `rate`.

It publishes the field `surf` (per cell, H_rms, the mean direction and the roller's energy) and adds its forcing to the water's `surfaceWaterForcing`. Reading the surf:
- `waveHeight(x, z)` (H_rms; H_s is about sqrt 2 times it) and `waveDirection(x, z)`;
- `rollerEnergy(x, z)`, `stokesDrift(x, z)`, `undertow(x, z)` and `forcing(x, z)`;
- `runUp(at?)`, the highest the water has reached up the shore on a line or on any line, the short waves' uprush included;
- `runUp2(at?)`, the run-up exceeded by 2 percent of the swash, Stockdon et al.'s R2 = 1.1 (<eta> + sqrt(S_inc^2 + S_IG^2) / 2) with the set-up and the infragravity swash from the water's own shoreline and the short waves' `incidentSwash(at?)` from Stockdon's law;
- `wetSand(x, z, window = 600)`, whether a spot was wet within the window, the short waves' uprush (half the incident swash above the shoreline) included.

The water's own `sample` gives the set-up and the currents.

```ts
import {bedSurface} from 'margoengine/physics/earth';
import {ShallowWaterSolver} from 'margoengine/physics/hydro';
import {SurfSolver} from 'margoengine/physics/surf';
import {PhysicsWorld} from 'margoengine/physics/world';

// A straight beach sloping 1 in 50 from 1.6 m of water, and a 0.4 m sea coming in 20 degrees off the normal.
const columns = 60, rows = 2, width = 120, depth = 8;
const elevations = new Float64Array((columns + 1) * (rows + 1));
for (let c = 0; c <= columns; c++)
  for (let r = 0; r <= rows; r++) elevations[r + (rows + 1) * c] = -1.6 + 0.02 * ((width * c) / columns);
const water = new ShallowWaterSolver();
const surf = new SurfSolver();
const world = new PhysicsWorld({rate: {num: 30, den: 1}})
  .add(water, {
    bed: bedSurface({columns, rows, width, depth, centre: [60, 4]}, elevations),
    level: 0,
    sides: {minX: {sea: 0}, minZ: 'periodic', maxZ: 'periodic'},
  })
  .add(surf, {water, incident: {height: 0.4, period: 7, direction: (20 * Math.PI) / 180}, alongshore: 'periodic'})
  .couple(['surf', 'water'], 'staggered');
world.advance(30 * 120); // two minutes
console.log(water.sample(60, 4).velocity[1] > 0.1); // true: a longshore current in the surf zone
console.log(surf.undertow(70, 4)[0] < 0); // true: the undertow runs seaward
console.log(surf.runUp() > 0.05); // true: the water runs up the beach above its still level
```

### Ships under way (`@margoengine/physics/ship`)

Ships that steam, turn, stop and berth (SEA-09).

`ShipSolver` holds each ship's rigid body through `bodyForces` with the MMG standard method (Yasukawa and Yoshimura 2015). That gives surge, sway and yaw: the hull's manoeuvring forces, the propeller's thrust in the wake it works in, and the rudder's normal force in the propeller's race, with the added masses and their coupling. The body then turns, drifts and stops as the method's ship does. Couple it before the rigid solver: `world.couple(['ship', 'rigid'], 'staggered')`. With a `HullSolver` floating the hull, use `['ship', 'hull', 'rigid']`.

Each ship is `{row, model}` and takes these settings:
- `model`: a `ManoeuvringModel` with the particulars, hydrodynamic derivatives and interaction constants. `KVLCC2_L7` is the 7 m KVLCC2 model of the paper, and `scaleModel(model, factor)` Froude-scales it (`scaleModel(KVLCC2_L7, 320 / 7)` is the tanker).
- `midship`, `forward` and `up` in the body's frame (defaults the origin, +X and +Y).
- `rudderRate`: default 2.32 degrees a second, the SOLAS 35-to-30 degrees in 28 s.
- `thruster`: `{diameter, power, position}` for a bow thruster.
- `block` and `addedMass`: pass `addedMass: false` when a HullSolver already carries the added masses.

The solver also takes `depth` (a number or a function of (x, z), for squat), `walls` (quays and banks, `{from, to}`) and `density`.

Steer with `control(i)`:
- `revolutions`, rev/s, negative astern; `revolutionsFor(i, speed)` gives the self-propulsion revolutions;
- `rudder`, the order in radians, positive to starboard;
- `thruster`, from -1 to 1.

`status(i)` reads speed, drift, yaw rate, rudder angle, the forces, the squat, the thruster's push and the quay's pull.

What it gives the rest of the engine:
- `sea(base)`: the sea drawn down along each hull by its squat (ICORELS and Hooft's form of Tuck's law, Huuska's factor in a channel). Pass it to the `HullSolver` as its sea, so the hull sinks and trims by its own hydrostatics and the drawdown shows. `drawdown(x, z)` reads it.
- `water`: a water `FlowField` of the propellers' races, the efflux by momentum theory and the jet's zones after Hamill and Kee (2016), for foam, bubbles, the bed and divers.
- `sources(t)`: each hull's draught pressed on the surface, for a `WakeSolver` (`sources: (t) => ships.sources(t)`), so it makes a bow wave and a Kelvin wake.
- `wash(t)`: where each race boils up to the surface, for a `FoamSolver` ship's `wash`, so the stern boils white even at the quay.
- The bow thruster: its ideal thrust (4 rho A)^(1/3) P^(2/3) times 0.55, falling to half near a speed of 0.4 of the jet's and recovering beyond.
- Suction toward a quay or bank alongside: the return flow squeezed through the gap.

The parts work on their own too:
- `Manoeuvring`: the MMG ship stepped by Runge-Kutta, with `selfPropulsion(speed)`.
- `Propeller`: open-water K_T and K_Q, four quadrants by Healey's lift and drag fitted to the curves, and the race's far-wake speed. `raceVelocity(race, point)` is the jet's velocity at a point.
- `holtropMennen(hull, speed)`: Holtrop and Mennen's resistance with the wake fraction, thrust deduction and eta_R; `ittc1957(Re)` is the friction line.
- `squat`, `icorels` and `huuska`, `rudderLiftSlope` (Fujii) and `thrusterThrust`.

```ts
import {Physics} from 'margoengine/physics';
import {KVLCC2_L7, Manoeuvring, ShipSolver, holtropMennen, squat} from 'margoengine/physics/ship';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

// The KVLCC2 model (7 m) at 1.18 m/s, 15.5 kn full scale, hard over to starboard: it turns in about 3.1 lengths.
const tanker = new Manoeuvring(KVLCC2_L7, {u: 1.18}, {rudderRate: 0.21});
tanker.revolutions = tanker.selfPropulsion(1.18);
tanker.order = (35 * Math.PI) / 180;
while (tanker.state.heading < Math.PI / 2) tanker.step(0.02);
console.log((tanker.state.x / 7).toFixed(1)); // 3.1

// Holtrop and Mennen's own example ship at 25 knots: 1,793 kN.
const hull = {length: 205, beam: 32, draughtFore: 10, draughtAft: 10, volume: 37500, lcb: -0.75, midship: 0.98, waterplane: 0.75,
  bulb: {area: 20, centre: 4}, transom: 16, appendages: [{area: 50, factor: 1.5}], stern: 10};
console.log(Math.round(holtropMennen(hull, 25 * 0.514444).total / 1000)); // 1793

// A 118 m cargo ship (C_B 0.667) at 8 knots over 10 m of water squats 0.24 m at the bow (ICORELS, C_S 1.7 below C_B 0.7).
console.log(squat({length: 118, beam: 17.1, draught: 7.76, block: 0.667, speed: 4.12, depth: 10}).bow.toFixed(2)); // 0.24

// The same model as a rigid body, turning under the ship solver.
await Physics.load();
const physics = new Physics(null, {fixedTimestep: 1 / 60, gravity: [0, 0, 0]});
const body = physics.addBody(null, {
  position: [0, 0, 0],
  linearVelocity: [1.18, 0, 0],
  colliders: {shape: 'box', halfExtents: [3.5, 0.46, 0.635], mass: 1025 * KVLCC2_L7.volume},
});
const ships = new ShipSolver();
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(ships, {ships: [{row: body.row, model: KVLCC2_L7, rudderRate: 0.21}]})
  .couple(['ship', 'rigid'], 'staggered');
ships.control(0).revolutions = ships.revolutionsFor(0, 1.18);
ships.control(0).rudder = (35 * Math.PI) / 180;
world.advance(60 * 20);
console.log(body.position[2] > 3); // true: well round to starboard (+Z)
```

### Loads in the water (`@margoengine/physics/loads`)

`LoadSolver` holds rigid bodies in the water through `bodyForces` with the water's loads (SEA-12): divers, debris, buoys, hoses, piles and dolphins. Couple it before the rigid solver: `world.couple(['loads', 'rigid'], 'staggered')`.

- **Compact bodies** (`bodies: [{row, shape}]`): a shape is `{sphere}`, `{ellipsoid}`, `{box}` or `{mesh}`, a mesh taken as its equivalent ellipsoid. Each body takes:
  - buoyancy of its submerged share and the Froude-Krylov force of the water's acceleration;
  - added mass per axis from Lamb's ellipsoid integrals, held implicitly so light bodies stay stable;
  - quadratic drag on its velocity through the water, a sphere's by Reynolds number (Morrison), else 1.0 or `drag`;
  - a spinning body's drag;
  - the wind's drag on its emerged part (`windage`, default 1), so floating debris drifts at a few percent of the wind.
- **Members** (`members: [{from, to, diameter, row?}]`): Morison's equation over the wetted length, its drag and added mass from DNV-RP-C205 by roughness (`roughness`, default 5e-5 m) and Keulegan-Carpenter number (`period`, default 8 s). A member takes Eames's tangential drag, and with `vortex: {strouhal, lift}` sheds vortices through Facchinetti's wake oscillator, its lift swinging at St U / D. A member on no `row` is fixed, a pile, and `memberLoad(i)` reports what it takes.
- **The water** (`sea`): a `SeaSurface`, or any `{elevation, water, density}` such as a flood's (`{elevation: (x, z) => shallow.sample(x, z).surface, water: shallow.flow, density: 1000}`). Add `flows` for currents and races (`ShipSolver.water`) and `wind` for windage.

The coefficients stand alone:
- `cylinderCoefficients(KC, k/D)`, `steadyDrag`, `wakeAmplification` and `cylinderAddedMass`;
- `morison`, `tangentialDrag`, `sphereDrag`, `sheddingFrequency` and `liftMagnification`;
- `ellipsoidAddedMass`, `ellipsoidAlphas` and `equivalentEllipsoid(mesh)`.

At a quay:
- `standingWave`, `sainflou` and `goda` give the wall's pressures and run-up for a wave;
- `thrusterEfflux` and `washOnBed` give a thruster's wash (PIANC);
- `QuayWall({from, to, freeboard})` samples the water at its face from any incident surface (a sea, a `WakeSolver`): the standing wave doubles there, where it tops the edge it splashes over, and a flow (a ship's race) gives the wash against the face.

```ts
import {Physics} from 'margoengine/physics';
import {LoadSolver, cylinderCoefficients, ellipsoidAddedMass} from 'margoengine/physics/loads';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

// A spheroid twice as long as it is wide carries 0.21 of its displaced mass moving along its axis and 0.70 across it.
console.log(ellipsoidAddedMass([2, 1, 1]).map((c) => c.toFixed(2)).join(' ')); // 0.21 0.70 0.70
// A smooth pile in waves at KC 10: C_D 0.71 and C_A 0.69 (DNV-RP-C205).
const {drag, addedMass} = cylinderCoefficients(10, 0);
console.log(drag.toFixed(2), addedMass.toFixed(2)); // 0.71 0.69

// A crate of 600 kg/m^3 dropped into still water floats with 0.59 of its height under (it bobs: small bodies here make no
// waves to damp them).
const still = {
  density: 1025,
  elevation: () => 0,
  water: {medium: 'water' as const, cell: [0, 0, 0] as const, sample: (_x: number, _y: number, _z: number, _t: number, out = {velocity: [0, 0, 0] as [number, number, number], density: 1025, temperature: 288}) => out},
};
await Physics.load();
const physics = new Physics(null, {fixedTimestep: 1 / 60});
const crate = physics.addBody(null, {position: [0, 1, 0], colliders: {shape: 'box', halfExtents: [1, 0.5, 0.5], mass: 1200}});
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(new LoadSolver(), {sea: still, bodies: [{row: crate.row, shape: {box: [1, 0.5, 0.5]}}]})
  .couple(['loads', 'rigid'], 'staggered');
world.advance(60 * 30);
console.log(Math.abs(crate.position[1]) < 0.5); // true: afloat
```

### Nonlinear and rogue waves (`@margoengine/physics/rogue`)

`NonlinearSea` is the sea a spectrum describes, to second order, with its rogue waves (SEA-03). From a directional spectrum (a `WaveSolver`'s field, or any `WaveSpectrumSample`) it draws a set of equal-variance components with phases from the counter-based random numbers. Its surface is their sum plus the bound waves each pair makes (Dalzell's finite-depth sum and difference kernels), so crests stand higher and sharper than troughs are deep, and wave groups carry their set-down. It is a `SeaSurface`: hulls, floating bodies, swimmers and spray read its height, slope, orbital motion and pressure as they read any sea's.

Its statistics are the freak-wave parameters of the ECMWF wave model:
- the steepness, the Benjamin-Feir index and the directionality R;
- the kurtosis, from four-wave focusing (J(R) BFI^2) plus the bound waves;
- the skewness, summed from the same kernels over the spectrum, so spreading lowers it;
- the chance a wave passes 2 H_s, or its crest 1.25 H_s (Tayfun and Fedele's crest law).

`heightChance`, `crestChance`, `expectedMaximum` (the expected largest of N waves) and `kurtosisFactor` (J(R)) are exported, with `seaStatistics(spectrum)` and `pairKernels` (the kernels of two waves).

Rogue waves are real events, each a constrained NewWave: the most likely shape of an extreme crest in this sea, solved into the sea so a crest of the height asked for stands at its place and time with the sea around it still the sea. Each fades in and out within a window of 8 zero-crossing periods and 8 zero-crossing wavelengths, and outside every window the sea is untouched, bit for bit. Its settings:
- `spectrum` or `waves` (with `at`, the place to sample it, default `[0, 0]`);
- `components` (default 160; a point costs about their square over 2 multiplications);
- `cutoff`, the highest frequency kept as a multiple of the peak (default 3);
- `seed` (default 0), `gravity`, `current` (a water `FlowField` added to the waves' motion) and `temperature` (default 288.15 K);
- `rogues`: `false`, a list of crests to place (`{position: [x, z], time, crest}`), or a region (`{min, max, from, to}`, default the 2 km square about `at` over the first hour) where the rogues focusing adds beyond the second order's own are drawn at the rate the statistics give. A long-crested narrow storm draws several an hour; a short-crested sea, whose R is above 1, draws none.

Runs of high waves, the Great Lakes' "three sisters":
- `runStatistics(spectrum, threshold, {method, kappa, period})`: how often a wave above `threshold` H_s is followed by another, by Kimura's (1980) chain of successive heights. It reports that chance (`persistence`), the mean run, `runsPerHour(j)` and `inARowPerHour(j)`. The correlation comes from the spectrum by Battjes and van Vledder (default), or by van Vledder's corrected estimate (`method: 'corrected'`), which gives longer groups. In a 10 s storm sea, three waves in a row above 1.5 H_s come about a hundred times as often as independent waves would bring them.
- `sisters(spectrum, {position, time}, crests)`: three crests at one place, a group's crest spacing apart. The spacing is `groupSpacing`, the sea's autocovariance's first maximum after its first minimum. Pass them to a `NonlinearSea` as its `rogues`, and it stands them up together as three successive crests at their heights.

Reading the sea:
- `elevation(x, z, t)`, `linearElevation(x, z, t)`, `sample(x, z, t)` (height, normal, velocity, current, depth, density), `velocity(x, y, z, t)` (linear theory under Wheeler's stretching), `pressure(x, y, z, t)` and `water`;
- `statistics`, `rogues` and `variance`.

```ts
import {NonlinearSea, sisters} from 'margoengine/physics/rogue';
import {jonswap} from 'margoengine/physics/waves';

// The North Sea on 1 January 1995: H_s 11.9 m, a peak period of 15 s in 70 m of water, and the Draupner wave's 18.5 m crest.
const frequencies = Float64Array.from({length: 40}, (_, i) => 0.03 * 20 ** (i / 39));
const directions = Float64Array.from({length: 36}, (_, j) => -Math.PI + ((j + 0.5) * Math.PI) / 18);
const spectrum = jonswap(
  {height: 11.9, period: 15, direction: 0},
  {frequencies, directions, energy: new Float64Array(40 * 36), depth: 70, density: 1025},
);
const sea = new NonlinearSea({spectrum, rogues: [{position: [0, 0], time: 600, crest: 18.5}]});
console.log(sea.elevation(0, 0, 600).toFixed(1)); // 18.5
console.log(sea.elevation(0, 0, 600) - sea.linearElevation(0, 0, 600) > 1); // true: the bound waves lift the crest
console.log(sea.statistics.rogueCrestChance > Math.exp(-12.5)); // true: crests pass 1.25 H_s more often than Rayleigh's
console.log(sea.elevation(0, 0, 100) === new NonlinearSea({spectrum, rogues: false}).elevation(0, 0, 100)); // true

// Lake Superior's three sisters: three crests of 7, 8 and 9 m at one place, one after another.
const superior = jonswap(
  {height: 7, period: 10, direction: 0},
  {frequencies, directions, energy: new Float64Array(40 * 36), depth: 150, density: 1000},
);
const three = sisters(superior, {position: [0, 0], time: 300}, [7, 8, 9]);
const lake = new NonlinearSea({spectrum: superior, rogues: three});
console.log(three.map((e) => lake.elevation(0, 0, e.time).toFixed(1)).join(' ')); // 7.0 8.0 9.0
```

### Solver modules on one memory

Every solver module of a world (a Rust crate built to WebAssembly) imports the world's one memory, so a solver reads
another's port where it lies, with no copy ([docs/physics-framework.md](../../docs/physics-framework.md), section 3).
The memory's low part belongs to the modules: the first 64 KiB is never used, then each module in the module table
(`scripts/physics-modules.mjs`) has a 64 KiB window at its slot, where the linker put its read-only data
(`--global-base`). `MODULE_SLOTS` (16) windows sit below `DYNAMIC_BASE`, and every region the `Arena` hands out lies
above it. A module keeps no state in statics and has no allocator: its state and ports are regions the world gave it,
so a snapshot of the world holds all of it. Each instance of a module, one per thread, runs on a stack region of its own.

The `Arena` is the world's one region allocator. `allocate(name, byteLength, type, layout)` hands out a zeroed region,
8-byte aligned, in the lowest free block it fits or else at the top, where the memory grows by whole pages.
`free(region)` gives a region back, and its block merges with free neighbours. `resize(region, byteLength)` keeps the
region's words up to the shorter length and zeroes the rest. It stays in place when the region shrinks, is the highest one,
or has a free block after it that holds the growth; otherwise it moves with one copy. Use the region it returns. Freeing or
resizing a region twice, or one from another arena, throws a `RangeError` and changes nothing. The same calls give the same
offsets on every run, and `used` and `freeBytes` read how far the regions reach and how much of that is free. A solver gets
the same three through its host (`host.allocate`, `host.resize`, `host.free`).

`loadSolverModule(arena, {name, slot}, {shared, plain})` takes the build that fits the memory, checks in a scratch
memory that its data lies inside its slot's window (a misplaced build is refused with `unsupported` before it writes a
byte of the world's), then instantiates it with a stack region from the arena. `worldMemory()` makes a shared memory
where the page may (worker threads step it in parallel) and a plain one elsewhere. A worker makes its own instance with
`instantiateSolverModule(memory, module, stack)` from the compiled module and a stack region the main thread posts it.
The tests run two such modules on one memory, read a port in place, snapshot and restore both, and give the same bits on
1, 2 and 4 threads and on the plain memory (`tests/world-modules.test.js`).

```ts
import {Arena, DYNAMIC_BASE, loadSolverModule, worldMemory, type ModuleBuilds} from 'margoengine/physics/world';

const arena = new Arena(worldMemory());
const particles = arena.allocate('particles', 1000 * 24, 'f32', 1);
console.log(particles.byteOffset >= DYNAMIC_BASE); // true: regions start above the module windows
const more = arena.resize(particles, 2000 * 24); // the top region grows where it is
console.log(more.byteOffset === particles.byteOffset); // true
arena.free(more); // its bytes go back to the arena
console.log(arena.used); // 0

// A module built by scripts/physics-modules.mjs for slot 0, in its shared and plain builds.
async function load(builds: ModuleBuilds) {
  const solver = await loadSolverModule(arena, {name: 'my-solver', slot: 0}, builds);
  return solver.exports; // its step functions take region offsets, such as particles.byteOffset
}
console.log(typeof load); // function
```

### Celestial ephemeris, tides and insolation (`@margoengine/physics/celestial`)

`CelestialSolver` advances the Sun, Moon and major planets with the physics world (SPACE-02). Its positions are geocentric J2000 vectors in metres. The two framework fields publish direct solar insolation and lunar/solar tidal potential. Read them through `insolationFromPort` and `tideFromPort`, passing the world memory and each solver's input port. Local samples use WGS 84 latitude and east longitude in radians, and optional ellipsoidal height in metres (default zero).

The default epoch is J2000, with TT and TDB seconds zero and UT1 seconds −63.86. To set another epoch, give `epoch.ttSeconds` and `epoch.ut1Seconds` as seconds from JD 2451545.0 on their respective timescales. Supply `epoch.tdbSeconds` when known. It defaults to TT. `timeScale` defaults to one astronomical second per world second. Zero freezes the sky and negative values run it backwards. Optional `orientation` supplies IERS celestial pole and locator, polar motion and TIO locator for the run. Defaults use IAU 2006 precession, four nutation terms and zero polar motion.

For high-precision or historical work, pass `ephemeris: new SpkEphemeris(bytes)` with a complete JPL planetary/lunar SPK kernel such as DE440s. The input can be an `ArrayBuffer` or `Uint8Array`. The reader copies the bytes and supports IEEE little- and big-endian J2000 type 2 and type 3 data. The default analytic mode uses JPL's fitted 1800–2050 orbit elements and the Meeus lunar series. SPK solar and lunar directions include light time and geocentric stellar aberration. Insolation is a geometric direct-beam estimate above the horizon. Clouds, atmospheric extinction and ocean response are supplied by their own solvers.

`trackSolarRow` takes an east–north–up direction and returns the requested rotation, physical angle and adjacent-row shading. It defaults to a north–south horizontal axis, zero cross slope and calibration offset, a width-to-spacing ratio of 0.4, ±90° travel, backtracking enabled and a horizontal night-stow angle. To stow in wind, pass `windSpeed` (default zero) and `stowAt`, both in m/s. See `TrackerOptions` for axis, cross-slope, travel and calibration options.

```ts
import {CelestialSolver, trackSolarRow} from 'margoengine/physics/celestial';
import {PhysicsWorld} from 'margoengine/physics/world';

const celestial = new CelestialSolver();
const world = new PhysicsWorld({rate: {num: 24, den: 1}}).add(celestial, {});
world.advance(24);

const sun = celestial.insolation({latitude: 0, longitude: 0});
const tide = celestial.tide([6378137, 0, 0]);
const row = trackSolarRow(sun.direction, {groundCoverageRatio: 0.5, stowAt: 15, windSpeed: 8});
console.log(sun.horizontal > 0, Number.isFinite(tide.potential), row.mode); // true true track
```

### Ice thermodynamics (`margoengine/physics/ice`)

`IceSolver` advances lake, river and sea ice, frost and dripping icicles at 60 Hz on a `PhysicsWorld`. Pass one
site per column, frost patch or icicle. `sample(index)` returns thickness (or icicle radius), icicle length,
liquid drainage and steam in kg/s, and externally absorbed heat in watts.

```ts
import { IceSolver } from 'margoengine/physics/ice';
import { PhysicsWorld } from 'margoengine/physics/world';

const ice = new IceSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(ice, {
  sites: [
    { kind: 'sheet', temperature: 263.15, salinity: 35, snowThickness: 0.04 },
    { kind: 'frost', temperature: 248.15 },
    { kind: 'icicle', waterSupply: 0.0001 },
  ],
});
world.advance(60);
console.log(ice.sample(0).thickness > 0, ice.sample(1).thickness > 0, ice.sample(2).length > 0); // true true true
```

Site temperatures are kelvin and default to 268.15 K. Sheet ice starts at zero thickness, in fresh water with no
snow or basal heat. Set `thickness` and `snowThickness` in metres, `salinity` on the practical salinity scale,
`conductivity` (default 2.03) and `snowConductivity` (default 0.31) in W/(m K), and `waterHeatFlux` (default 0)
in W/m², positive into the ice. The water remains at its salinity-adjusted freezing point through phase change.
Frost starts at zero thickness with density 100 kg/m³, ambient vapour pressure 400 Pa, air temperature 273.15 K,
mass transfer coefficient 0.002 m/s and thaw heat transfer coefficient 10 W/(m² K). Icicles have an initial
attachment radius of 0.005 m, zero length, water supply 0.00001 kg/s, and separate side and tip heat transfer
coefficients of 10 W/(m² K). `area` is the footprint that absorbs external heat, default 1 m² for sheets and
frost or π times the squared attachment radius for an icicle. Each default can be overridden per site.

For world-driven forcing, turn on `readHeat`, `readTemperature` and/or `readVapour` on the solver and provide a
writer for each enabled field. All ports are layout-1 `f64` in the site's array order.

| Descriptor | Field | Words per site |
| --- | --- | --- |
| `ICE_HEAT_FIELD` | `iceSurfaceHeat` | Positive incident flux in W/m² |
| `ICE_TEMPERATURE_FIELD` | `iceBoundaryTemperature` | Boundary temperature in K |
| `ICE_VAPOUR_FIELD` | `iceVapourPressure` | Vapour partial pressure in Pa |
| `ICE_GEOMETRY_FIELD` | `iceGeometry` | Thickness and zero, or icicle radius and length, all in metres |
| `ICE_MELTWATER_FIELD` | `iceMeltwater` | Liquid drainage, including unfrozen icicle feed, in kg/s |
| `ICE_STEAM_FIELD` | `iceSteam` | Steam in kg/s for heat-source or atmospheric feedback |
| `ICE_HEAT_ABSORPTION_FIELD` | `iceHeatAbsorption` | Absorbed power in W for heat-source cooling |

The three readers default to off. With an upstream source that also consumes returned cooling or steam, call
`world.couple([sourceId, 'ice-thermodynamics'], 'staggered')` for same-tick heating and returned rates on the next
source tick. A solver instance owns the four output fields in its world. Its ID defaults to
`'ice-thermodynamics'`.

### Underwater acoustics (`margoengine/physics/underwater`)

`UnderwaterAcousticsSolver` traces sound rays through a layered water column at 60 Hz. Each ray carries a
Gaussian beam whose width, phase and curvature change as the ray bends or reflects.

```ts
import { UnderwaterAcousticsSolver, acousticBeamPressure } from 'margoengine/physics/underwater';
import { PhysicsWorld } from 'margoengine/physics/world';

const acoustics = new UnderwaterAcousticsSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(acoustics, {
  profile: [
    { depth: 0, speed: 1510 },
    { depth: 25, speed: 1480 },
    { depth: 60, speed: 1500 },
  ],
  rays: [{ depth: 10, declination: 0.3, frequency: 1000 }],
});
world.advance(12);
const ray = acoustics.sample(0);
const pressure = acousticBeamPressure(ray, 2);
console.log(ray.range > 0, ray.width > 0, Number.isFinite(pressure.real)); // true true true
```

The profile starts at zero depth and ends at the bottom. Depth is metres down and sound speed is m/s.
Knots must have increasing depths. The default is 1500 m/s between 0 and 100 m. `soundSpeed(depth)` reads the
interpolated speed. With no `rays`, launch one ray horizontally at mid-depth. Each ray accepts `depth`
(mid-depth), `declination` (0 rad, positive down), `frequency` (1000 Hz), `waist` (5 m at the 1/e pressure
radius) and `pressure` (1 Pa). Set `surfaceReflection` (−1 for a pressure-release surface), `bottomReflection`
(0.8), and `absorption` (0 dB/km) for the water column. The signed boundary coefficients multiply pressure.
Pass `{ id }` to the constructor to name a second column. The default ID is `'underwater-acoustics'`.

`sample(index)` gives the current ray in launch-array order. Use `acousticBeamPressure(ray, offset)` with a
perpendicular offset in metres to obtain the real and imaginary pressure in Pa at the current wavefront.
For another solver, read the layout-1 f64 ports below. The source ID prefixes each suffix.

| Descriptor property | Suffix | Words per ray |
| --- | --- | --- |
| `pathField` | `.path` | Range, depth, total path length and beam width in metres |
| `signalField` | `.signal` | Real and imaginary on-axis pressure in Pa |
| `delayField` | `.delay` | Travel time in seconds |

### Orbital mechanics (`margoengine/physics/orbit`)

`OrbitSolver` integrates interacting gravitational bodies and massless tracers on the 60 Hz physics clock.
The optional SIMD kernel implements reversible fourth-order Yoshida stepping in vacuum, with a Verlet option.

```ts
import { OrbitSolver, keplerState } from 'margoengine/physics/orbit';
import { PhysicsWorld } from 'margoengine/physics/world';

const orbit = await OrbitSolver.load();
const mass = 5.9722e24;
const satellite = keplerState({ gravitationalParameter: 3.986004418e14, semimajorAxis: 7e6 });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(orbit, {
  bodies: [{ position: [0, 0, 0], mass }, satellite],
  timeScale: 60,
});
world.advance(60);
console.log(orbit.sample(1).position[1] > 0, Math.round(orbit.elapsedSeconds)); // true 60
```

Use metres, m/s and gravitational masses in kg in one Cartesian inertial frame. A body defaults to zero velocity
and zero mass. A massless body follows the field and contributes no gravitational force. `timeScale` is simulated
seconds per world second (default 1). `substeps` is a positive power of two (default 1). Use more subdivisions
when the closest encounter or orbital period is short compared with a step.
`integrator` defaults to `'yoshida'` and also accepts `'verlet'`. `softening` is the Plummer length in metres
(default 0). `gravitationalConstant` defaults to the CODATA value.

An optional `primary` specifies the gravitating body index and its equatorial `radius` in metres.
`j2` (default 0) adds axial quadrupole gravity. To model atmospheric deceleration, set the primary's
`density` in kg/m³ at its radius (default 0), `scaleHeight` in metres (default 8500), and
`angularVelocity` in rad/s (default 0, about inertial z). Give each affected body a `dragAreaPerMass` in m²/kg
(default 0). The density is a local exponential profile. Use `@margoengine/sciviz/geo`'s existing `SGP4`
for space-track mean elements. Numerical Cartesian propagation starts from a state in the chosen frame.

`positionField` and `velocityField` publish three f64 values per body and `timeField` publishes elapsed seconds.
All three ports use layout 1 and the solver ID as the prefix (default `orbit`). `OrbitSolver.load({ signal })`
can cancel the optional load. `keplerState` samples an ideal ellipse and `keplerDiskSample` integrates
the phase of a tracer with a prescribed radial drift. A viewer can set `hole.diskTime = orbit.elapsedSeconds`
to replay a disk on the simulation's clock.

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

### Heat conduction and phase change

Use [the physics world](#the-solver-contract-margoenginephysicsworld) to advance heat diffusion independently of the frame rate.
`HeatConduction` loads a SIMD Wasm kernel from the optional `@margoengine/physics/thermal` entry.
It supports plain and shared world memory. The browser loads the shared build only when the page can use shared memory.
It simulates a cell-centred grid with one material or a palette of materials.
Insulated faces are the default. Set a fixed temperature, convection, radiation, or an inward heat flux at each exterior face.

```ts
import { HeatConduction } from '@margoengine/physics/thermal';
import { PhysicsWorld } from '@margoengine/physics/world';

const heat = await HeatConduction.load();
const world = new PhysicsWorld({ rate: { num: 24, den: 1 } });
world.add(heat, {
  dimensions: [8, 1, 1],
  cellSize: [0.01, 0.05, 0.05],
  materials: { conductivity: 1.8, heatCapacity: 1_600_000 },
  initialTemperature: 900,
  integration: 'implicit',
  boundaries: { xMin: { kind: 'convection', kelvin: 293.15, coefficient: 24 } },
});
world.advance(240);
const temperatures = heat.readTemperature();
console.log(temperatures[0], temperatures[7]);
```

Temperatures are in K. The convection coefficient is in W/(m² K). A radiation boundary sets diffuse-grey emissivity from 0 to 1. It can combine radiation with a convection film at the same ambient temperature. A `flux` boundary uses W/m²,
positive into the grid. A material's optional `phaseChange` supplies the melting temperature in K
and volumetric latent heat in J/m³. Give `liquidHeatCapacity` when the phases have different capacities.
`initialTemperature`, `initialLiquidFraction`, and `materialIndices` accept one value per cell in x-fastest order.

Time integration defaults to forward Euler. Set `integration: 'implicit'` for backward Euler, which uses the
new temperature for conductive and radiative fluxes. Both methods may choose a finer dyadic world rate.

The temperature, enthalpy, and liquid-fraction fields are f64 grids in that same order.
A coupled solver can add J per tick per cell into `heat.enthalpyField`. Sources and readers must use
the same grid and origin cell. The world snapshots geometry, material coefficients, and state.
`HeatConduction.load({ signal })` accepts cancellation, and an optional `id` gives each grid independent field names.

### Thermal stress in a solid

`Thermoelasticity` reads a heat grid's temperature port and solves small-strain mechanical equilibrium. Give it
the same cell counts and sizes as the heat grid. Each material supplies Young's modulus in Pa, Poisson's ratio,
and its linear thermal expansion coefficient in 1/K. The stress-free temperature defaults to 293.15 K.

```ts
import { HeatConduction, Thermoelasticity, type ThermoelasticRestraint } from '@margoengine/physics/thermal';
import { PhysicsWorld } from '@margoengine/physics/world';

const dimensions = [2, 1, 1] as const;
const cellSize = [0.1, 0.1, 0.1] as const;
const heat = await HeatConduction.load();
const solid = await Thermoelasticity.load({ temperatureField: heat.temperatureField });
const restraints: ThermoelasticRestraint[] = [];
for (const x of [0, dimensions[0]]) {
  for (const y of [0, 1]) {
    for (const z of [0, 1]) restraints.push({ node: [x, y, z], displacement: [0, null, null] });
  }
}
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
world.add(heat, {
  dimensions, cellSize, initialTemperature: 333.15,
  materials: { conductivity: 210, heatCapacity: 2_400_000 },
});
world.add(solid, {
  dimensions, cellSize, restraints,
  materials: { youngModulus: 69e9, poissonRatio: 0.33, expansionCoefficient: 23e-6 },
});
world.advance(1);
console.log(solid.readStress()[0]); // axial compression in Pa
```

A node restraint fixes each supplied displacement in metres. A `null` component is free. The solver adds
the minimal coordinate restraints needed to remove rigid translation and rotation. Read node displacement in metres,
cell-average stress in [xx, yy, zz, xy, yz, zx] order in Pa, and reactions at user restraints in N. All arrays are
x-fastest. Set `relativeTolerance` to control the residual (default 1e-9) and `maxIterations` for the solve
(default twice the number of free nodal degrees of freedom, at least one). Supply `liquidFractionField` to reject cells that begin
to melt. The elastic model assumes bonded solid cells and uses one-way coupling from heat to deformation.


## Collective animal motion

The optional `@margoengine/physics/schooling` entry simulates schools, flocks, herds and swarms on the world clock.
Close neighbours trigger priority repulsion. The middle zone aligns with nearby motion, and the outer zone draws
stragglers toward their peers. The `neighbours` option limits alignment and attraction to that many nearest
visible members, with ties by input row. The default considers all visible members up to the sensing radius.
Choose a count for the species and observations. The predator rule checks the closest point along the relative
trajectory over `predictionSeconds`.

```js
import { SchoolSolver } from '@margoengine/physics/schooling';
import { PhysicsWorld } from '@margoengine/physics/world';

const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const school = await SchoolSolver.load();
world.add(school, {
  members: [
    { position: [-0.5, 0, 0], velocity: [0, 0, 1], mass: 0.2, dragArea: 0.002, maxThrust: 0.5 },
    { position: [0.5, 0, 0], velocity: [0, 0, 1], mass: 0.2, dragArea: 0.002, maxThrust: 0.5 },
  ],
  predators: [{ position: [0, 0, -3], velocity: [0, 0, 5] }],
  density: 1000,
});
world.advance(60);
const fish = school.read(0);
console.log(fish.position, fish.velocity, fish.intent);
```

- `SchoolSolver.load({ id, level, mode, readPredators, fields, signal })` loads the SIMD kernel on demand. The solver supports
  plain and shared world memory. A browser without cross-origin isolation loads the plain build. Defaults are id `school`, level 0 (60 Hz), mode `point-mass`, and `readPredators: false`. Use `fields.intent`,
  `fields.kinematics`, or `fields.predators` to give a group its own registry names. The default names are
  `schoolIntent`, `schoolKinematics`, and `schoolPredators`.
- `repulsionRadius`, `orientationRadius`, and `attractionRadius` default to 0.5, 2, and 6 m. `visionDot`
  defaults to −1 (full view). `predatorRadius` and `predictionSeconds` default to 2 m and 1 s. A zero threat
  radius disables avoidance. Point masses chase a medium-relative `cruiseSpeed` of 1 m/s with a
  `responseSeconds` of 0.5 s by default.
- Each point member defaults to a mass of 1 kg, a peak thrust of 1 N, drag area 0 m², maximum lateral acceleration
  2 m/s², and minimum turn radius 0.2 m. `dragArea` means coefficient of drag times reference area. Specify a
  `FlowField` to sample local velocity and density, or use motionless fluid of `density` (1.225 kg/m³ by default).
  Local flow is subtracted before members compare headings. The normal acceleration is bounded by `maxLateralAcceleration` and speed squared divided by `minimumTurnRadius`.
  A minimum radius of 0 disables the radius constraint. Point masses advance position after updating velocity.
- A body solver can own locomotion with `mode: 'intent'`. Write `SCHOOL_KINEMATICS_FIELD` and read
  `SCHOOL_INTENT_FIELD`. The kinematics port holds six f64 words per stable member row (position, then world velocity).
  The intent port holds three f64 words per row (desired medium-relative velocity on world axes). The member list
  sets the row count. Use `readPredators: true` and `predatorCount` to read the same six-word layout from
  `SCHOOL_PREDATORS_FIELD`. Otherwise configured predators move at their initial velocities. All three use
  `SCHOOL_LAYOUT`. Set `cellSize: world.cellSize` with custom-size cells to bring inputs and flow samples into the
  correct local frame. `school.read(row, out?)` copies scalar state and intent into ordinary vectors.

## Aquatic locomotion

`SwimSolver` advances fish, cetaceans, rays and divers as six-degree-of-freedom bodies on the world clock.
The tail's travelling wave supplies thrust, while water resistance, buoyancy and fin loads determine speed,
course and bank. Sample the spine to pose a rig and read the pectoral displacement to pose its fins.

```js
import { SwimSolver } from '@margoengine/physics/life';
import { PhysicsWorld } from '@margoengine/physics/world';

const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const swim = await SwimSolver.load();
world.add(swim, {
  bodies: [{
    position: [0, -2, 0],
    mass: 12.88,
    length: 0.75,
    width: 0.2,
    height: 0.16,
    tail: { amplitude: 0.07, span: 0.2, wavelength: 0.85 },
    frequency: 1.5,
    fins: { area: 0.025, strokeAmplitude: 0.12, strokeFrequency: 1.5 },
  }],
});
world.advance(60);
const fish = swim.read(0);
const tail = swim.sampleSpine(0, 1);
console.log(fish.position, fish.orientation, tail.position, fish.finDisplacement);
```

Local axes are +z forward, +y dorsal and +x right. Supply a tail's one-sided excursion, full span
and wavelength in metres. The default stroke is lateral. Set `plane: 'vertical'` for a fluke.
`swimPropulsion(tail, frequency, throughSpeed, density?)` reports mean thrust, through-flow power,
efficiency and the Strouhal number. The density default is 1,025 kg/m³. Geometry supplies ellipsoid
volume and skin area by default. Use measured `volume`, `buoyancyCentre` or `wettedArea` if available.
Form drag defaults to a coefficient of 0.1 times the frontal area. Transverse drag coefficients default
to 1 and use elliptical strips. Axial added mass defaults to zero in the slender-body approximation.

Initial velocity and angular velocity default to zero and orientation to identity. Open-loop `frequency`
defaults to zero. A `target` can specify a position or a world velocity, optionally relative to the water.
Feedback chooses the beat frequency and fin forces, bounded by the supplied fins and `maximumFrequency`
(default at least 3 Hz). `responseSeconds` defaults to 1 s. `burstSeconds` and `coastSeconds` select a
periodic duty cycle. `setControl(row, { effort, buoyancy, target })` changes the normalized effort, displaced
volume multiplier or target between advances. The world saves these commands in its snapshots.
`fins.area` is the combined area. Lift and drag coefficients default to 1. Scull amplitude and frequency
default to zero. The default fore-aft moment arm is one-quarter body length and the default half-spacing is
half the body width. Set `steering` to local x/y lift and axial sculling commands from −1 to 1.

Pass a `SeaSurface` as `sea` for orbital flow and free-surface swimming or pass a `SeaWater` as `flow`
for an all-water domain. Standalone water density defaults to 1,025 kg/m³. Kinematic viscosity defaults to
1.05e−6 m²/s and the laminar-to-ITTC blend begins at Reynolds number 500,000. Set `cellSize: world.cellSize`
with a custom-sized world. Swimmers publish `SCHOOL_KINEMATICS_FIELD`; `readSchoolIntent: true` reads the
matching medium-relative intent. Place both solvers in a staggered coupling group with equal row counts.
`readContacts: true` reads `SWIM_CONTACT_FIELD`, six f64 words of world force and torque about each body's
centre of mass per stable row. `SWIM_WAKE_FIELD` writes two layout-1 f64 rows per swimmer in tail/fin order,
each [x, y, z, impulseX, impulseY, impulseZ, radius, wetFraction]. Wakes describe momentum injected during
the published step. Use `fields` to name separate ports for different groups.

`SwimSolver.load({ id, level, signal })` accepts a solver id (default `swim`), preferred level (default 0)
and load cancellation. The world raises the rate to resolve the stroke or angular motion. The entry loads its
own Wasm on demand and uses either plain or shared world memory.

## Falling light bodies

Use `@margoengine/physics/falling` for rigid paper, dry leaves, ash flakes, plate-like snow and feathers,
autorotating seeds, and round grains. Each body advances at the same world time, with adaptive dyadic Runge–Kutta
substeps inside each tick. Densities and velocities are in SI units.

```js
import { FallingSolver } from '@margoengine/physics/falling';
import { PhysicsWorld } from '@margoengine/physics/world';

const falling = await FallingSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
world.add(falling, {
  bodies: [
    { kind: 'plate', mass: 0.006, chord: 0.1, span: 0.25, position: [0, 4, 0], angle: 0.18 },
    {
      kind: 'samara', mass: 0.0001, spinInertia: 1.35e-8, position: [1, 4, 0],
      sections: [{ start: 0, end: 0.0368, chord: 0.0084 }],
    },
  ],
});
world.advance(60);
console.log(falling.pose(0), falling.pose(1));
```

Plates have a fixed pitch-axis direction (default +Z). A tilted release allows the pressure and torque
to develop flutter or tumble. Specify chord, span, mass and thickness, and optionally override the
elliptical-section pitch inertia and the published lift and drag coefficients. Samaras orbit their
fixed spin axis with loads integrated over their radial strips. Each strip has an inner and outer
radius, chord, pitch and azimuth. The default pitch is −7°. The spin axis defaults to opposite gravity.
A rounded body specifies a diameter, mass and drag coefficient or local drag law. Supply a
`FallingBoundary` to give rounded bodies static scene contact. `fallingBoundaryFromPhysics` adapts a
scene's fixed, nonsensor colliders.

Pass a `Wind` and use `cellSize: world.cellSize` with a custom world cell size. With no wind source,
the solver uses motionless standard sea-level air. A wind with zero density gives a vacuum.
`FallingSolver.load({ id, rate, signal })` loads the Wasm on demand. Rate 2 (240 Hz) is the default.
`falling.poseField` publishes layout-1 f64 rows in input order, in the solver's origin cell.
Each row holds position xyz, quaternion xyzw, linear velocity xyz and angular velocity xyz.
`falling.pose(index)` copies a row. `writeSpheres` writes the positions, radii and velocities of rounded
bodies to a supplied f32 draw buffer in their original order.

## Pedestrian contact and crowd motion

Use `PedestrianCrowd` for walkers that push, yield, and queue around doorways. It advances bodies
on the PhysicsWorld clock with physical contact forces and a separate response to predicted encounters.
A person can turn their elliptical torso through a narrow aperture. The solver reads a NavMesh route and
height surface, so walkable grades and the positions used to animate feet stay in the same coordinate system.

```js
import { PedestrianCrowd } from '@margoengine/physics/pedestrians';
import { PhysicsWorld } from '@margoengine/physics/world';

const crowd = await PedestrianCrowd.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
world.add(crowd, {
  bodies: [
    { position: [-0.3, 0, -1], mass: 55, path: [[0, 0, 0.4], [-0.5, 0, 3]] },
    { position: [0.3, 0, -1.5], mass: 80, path: [[0, 0, 0.4], [0.5, 0, 3]] },
  ],
  walls: [[[-3, 0], [-0.4, 0]], [[0.4, 0], [3, 0]]],
  apertures: [[[-0.4, 0], [0.4, 0]]],
});
world.advance(90);
const walker = crowd.read(0);
console.log(walker.position, walker.heading, walker.normalLoad, walker.distanceTravelled);
```

The world axes are y up. Walls and apertures are XZ segments from their two endpoints in the
solver's cell. A walker starts at its feet position and has a default mass of 75 kg, width of 0.46 m,
depth of 0.28 m, forward heading +z and zero velocity. It responds over 0.5 s by default, can propel
itself at up to 3 m/s² and turn its heading at up to π rad/s. The default free route speed is 1.34 m/s
and waypoint arrival distance is 0.1 m. A path can use `mesh.route(start, end).points`, and the same
mesh can sample the ground height. Supply `preferredVelocity` for a walker without a route. Call
`setPreferredVelocity(row, [vx, vz])` to change it between advances and use `null` to resume a path.
Snapshots restore the route cursor, velocity override, distance travelled and all integrated state.

Compression stiffness defaults to 120,000 N/m, approach damping to 0 N s/m, and sliding damping
to 240,000 N s/m². Standing jam loads are available in newtons through `normalLoad` even when
forces from different sides cancel in `contactForce`. Anticipation defaults to an energy coefficient of
1 J s², a decay of 3 s, observation horizon of 6 s and reaction offset of 0.15 s. It sends a force
before collision, when current trajectories have a future meeting. A normalized density field has a
default radius of 1 m. Walkers reduce their preferred speed above the default packing density
of 5.4 people/m², with `densityResponse` defaulting to 1. Set `packingDensity: 0` to disable that
response. The aperture shoulder clearance defaults to 0.01 m per side.

`PedestrianCrowd.load({ id, level, signal, readIntent, readForces, fields })` loads SIMD Wasm on
demand. Defaults are id `pedestrians`, preferred level 0 and both input ports disabled. When enabled,
write `PEDESTRIAN_INTENT_FIELD` with [vx, vz] and `PEDESTRIAN_FORCE_FIELD` with [fx, fz], one
f64 row per walker. Readers can use `PEDESTRIAN_KINEMATICS_FIELD` for motion and accumulated
stride distance, and `PEDESTRIAN_CONTACT_FIELD` for [fx, fz, normalLoad, density,
anticipatoryFx, anticipatoryFz]. All four use `PEDESTRIAN_LAYOUT`. Use different `fields` names for
multiple groups within one world. The same kernel runs in plain and shared world memory.

## Landscape evolution

`@margoengine/physics/landscape` routes rainfall in multiple directions, cuts streams with an implicit
stream-power step, moves size-classified sediment and redistributes downhill soil. It publishes elevation
changes to the same TerrainBed used by water, landslides and rigid colliders. The native solver loads on
demand and supports plain and shared world memory.

```ts
import { type BedShape, TerrainBed } from '@margoengine/physics/earth';
import { LandscapeEvolution } from '@margoengine/physics/landscape';
import { PhysicsWorld } from '@margoengine/physics/world';

const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const grid: BedShape = { columns: 10, rows: 5, width: 100, depth: 50, centre: [0, 0] };
const bed = new TerrainBed();
const landscape = await LandscapeEvolution.load();
world.add(bed, { ...grid, elevations: (x, z) => 8 - 0.12 * x + 0.006 * z * z });
world.add(landscape, {
  grid,
  secondsPerSecond: 31_557_600 * 60,
  uplift: 0.0004 / 31_557_600,
  outlets: { maxX: true },
  grains: [{ diameter: 0.0003, fraction: 3 }, { diameter: 0.004, fraction: 1 }],
});
world.advance(60);
console.log(landscape.read(5, 2).discharge, landscape.budget.exported, bed.elevations()[0]);
```

The default time scale is real-time. Rainfall defaults to one metre per Julian year, uplift to zero,
erodibility to `1e-11` with discharge exponent 0.5 and a linear slope law. Use SI units even when accelerating
geological time. The Manning roughness is 0.03, fluid density 1,000 kg/m³, bed porosity 0.4, mobile soil depth
0.1 m and default grain diameter 0.0003 m. Unspecified grains have density 2,650 kg/m³, critical Shields number
0.0495 and zero extra travel length. Linear and thermal diffusivities default to `1e-8` and `1e-7` m²/s.
Thermal transfer starts above a slope of tan(30°). The rock stress threshold is zero unless supplied.

Outlets default to closed. An open edge keeps its elevation and exports arriving water and sediment. Provide
the same `floor` to the landscape and `bedrock` to TerrainBed if there is a minimum elevation. Optional
`rainField`, `shearField` and `rootCohesionField` accept layout-1 cell or vertex scalars in m/s, Pa and Pa.
Use `SedimentTransport.shearField` or a time-averaged equivalent for hydraulic forcing. `load` also accepts
`id` (default `landscape`) and `signal`. Discharge, gross incision and sediment flux are layout-1 f64 vertex
fields. TerrainBed applies a published change at its next tick, so diagnostics describe the most recent
calculated change one tick before it becomes terrain. Use the bed for the current rendered elevation.

## Tropical cyclones and compact vortices

`StormVortex` is a world-space `Wind` with surface pressure in pascals, a moving centre and a 10 m
wind profile. The default tropical cyclone has a 30 km peak-radius scale and a 6,000 Pa central
pressure deficit. A tornado, waterspout, dust devil, or fire whirl uses a compact cyclostrophic
profile. Select `compactProfile: 'rankine'` for the algebraic outer tail or use the default Burgers–Rott.
The field supports plants, airborne particles, and rigid wind loads. Bind a visual hurricane with
`StormVortex.fromHurricane(storm.resolved)` to keep centre, pressure and wind consistent.

```ts
import { StormVortex, VortexForcing } from 'margoengine/physics/vortices';
import { PhysicsWorld } from 'margoengine/physics/world';

const storm = new StormVortex({ pressureDrop: 15000, radius: 30000, translation: [5, 0] });
const coupling = new VortexForcing();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(coupling, {
  vortex: storm,
  probes: [[30000, 10, 0]],
});
world.advance(1);
const { velocity, pressure } = coupling.weather();
console.log(Math.hypot(velocity[0], velocity[2]) > 60, pressure < storm.ambientPressure);
```

Enable `{ rigid: true }` on `VortexForcing` to apply drag and torque to selected rigid rows and publish
loads and retained limit crossings. Enable `{ water: true }` to contribute spatial pressure gradients
and wind stress on a matching shallow-water grid. Use `StormVortex.inverseBarometer()` for an open
boundary's pressure correction. If another producer already supplies the wind stress, use
`water.windStress: false`.

## Seismic waves and ground motion

`@margoengine/physics/seismic` solves P and SV waves through a vertical geological section. Supply density
and the two wave speeds per cell or use one material throughout. The top surface is traction-free.
The optional absorbing strip damps the sides and bottom. Grid spacing defaults to 10 m on both axes.
Moment sources take x and depth in metres from the section's top-left corner. The reported vertical
motion is positive up. World tick rate follows the spatial Courant bound.

```ts
import { SeismicGround } from 'margoengine/physics/seismic';
import { PhysicsWorld } from 'margoengine/physics/world';

const ground = await SeismicGround.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(ground, {
  width: 25,
  depth: 20,
  spacing: [1, 1],
  material: (_x, depth) => depth < 4
    ? { density: 1800, compressionalSpeed: 55, shearSpeed: 25 }
    : { density: 2400, compressionalSpeed: 90, shearSpeed: 50 },
  sources: [{ position: [14, 8], moment: [90000, -90000, 60000], timescale: 0.03 }],
  sites: [{
    x: 11.5,
    frequency: 2.5,
    saturatedSoil: { overburdenRatio: 1.7, depthReduction: 0.92, cyclicResistance: 0.18 },
  }],
});
world.advance(60);
console.log(ground.motion(11).peakHorizontalAcceleration > 0, ground.reading().cyclicStress > 0);
```

The ground-motion field supplies acceleration for cameras and structural consumers. `SeismicInertialLoad`
maps selected rigid bodies to support columns and adds a mass-scaled base-acceleration load. The optional
single-mode building receiver defaults to a 0.05 damping ratio. Its soil receiver compares peak horizontal
cyclic demand with the supplied resistance. The default boundary attenuation targets an outgoing amplitude
of 0.001 through at most 12 cells, reduced automatically for small grids. Set `absorbingCells: 0` to study
boundary reflections. A `signal` can cancel kernel loading.

## Outdoor sound

`@margoengine/physics/outdoor-sound` gives each source–listener link its travel time and eight octave gains.
Set `air` to a Weather wind field for advection and vertical refraction, and `bed` to a TerrainBed for
diffraction. An explicit `groundY` adds a plane reflection. The reflected pressure defaults to full strength
and `groundReflection: 0` turns it off. With still air, temperature defaults to 293.15 K, pressure to
101,325 Pa, and relative humidity to 0.5. Call `read` after advancing the world. Callbacks for moving links
take world seconds and return metres relative to the solver cell. For a nonstandard world cell size, pass the
same `cellSize` to the solver. The default is 4,096 m per cell.

```ts
import { OutdoorSound } from 'margoengine/physics/outdoor-sound';
import { PhysicsWorld } from 'margoengine/physics/world';

const paths = new OutdoorSound();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(paths, {
  links: [{ source: [0, 3, 0], listener: [3000, 3, 0] }],
});
world.advance(1);
console.log(paths.read().delaySeconds.toFixed(2)); // 8.74
```

`read` also provides the band losses before summing spreading, air, terrain, and interference. Use
`aviationNWave` for a prescribed far-field civil aviation signature. For a playback delay, pass the reading
to the optional `OutdoorAudio` controller.

## Contact and modal sound

Use @margoengine/physics/modal-sound with a PhysicsWorld to turn collision, scrape, roll and fracture
loads into mono audio tracks. A material supplies resonant frequencies, damping rates and gains.
The example records one second at 24 frames per second and plays it through Web Audio's offline renderer.
It uses plain world memory, the rigid module's current arena format.

```ts
import { Physics } from '@margoengine/physics';
import { ModalContactRigidSolver, ModalSoundSolver } from '@margoengine/physics/modal-sound';
import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';

await Physics.load();
const world = new PhysicsWorld({ rate: { num: 24, den: 1 }, memory: worldMemory(false) });
const physics = new Physics(null, { fixedTimestep: 1 / 60, arena: world.arena });
physics.addBody(null, {
  type: 'fixed',
  position: [0, -0.1, 0],
  colliders: { shape: 'box', halfExtents: [4, 0.1, 4] },
});
const bell = physics.addBody(null, {
  position: [0, 1, 0],
  colliders: { shape: 'sphere', radius: 0.25, mass: 0.6 },
});
const sound = await ModalSoundSolver.load();
world.add(new ModalContactRigidSolver(sound), { physics, emitters: [bell] });
world.add(sound, { tracks: [{ material: 'bell' }] });

const pcm = new Float32Array(48000);
let cursor = 0;
for (let frame = 1; frame <= 24; frame++) {
  world.advance(frame);
  const block = sound.copySince(cursor);
  if (!block) continue;
  pcm.set(block.samples, block.firstSample);
  cursor += block.samples.length;
}

const context = new window.OfflineAudioContext(1, pcm.length, 48000);
const buffer = context.createBuffer(1, pcm.length, 48000);
buffer.copyToChannel(pcm, 0);
const source = context.createBufferSource();
source.buffer = buffer;
source.connect(context.destination);
source.start();
const printed = (await context.startRendering()).getChannelData(0);
if (cursor !== 48000 || printed[0] !== 0 || !printed.some((sample) => Math.abs(sample) > 0.05)) {
  throw new Error('Modal audio is incomplete or silent. Keep the two solvers and the dropped body in the example.');
}
physics.dispose();
```

The wood, metal, glass and bell presets provide authored examples. Call `modalPreset(name)` for a fresh material
you can customize, or supply the damped frequencies in Hz, amplitude decays in 1/s and signed PCM gains per
N s from measured objects. Each mode can have its own scrape, roll and fracture gain multipliers. Default
scrape and rolling roughness are 0.4 and 0.2 N/√W. Their feature spacing defaults to 0.006 m and 0.024 m.
Set the rigid emitter list in track order. A null emitter leaves its track free for fracture input.
Rigid approach speed must exceed `impactSpeed` (default 0.25 m/s) to excite an impact. `rollingResistance`
defaults to 0.025.

Use `ModalSoundSolver.load({ id, rate, inputs, signal })` to set the field prefix, dyadic rate, declared input
owners and load cancellation. Defaults are `modalSound`, level 0 (60 Hz) and `contacts`. Match the rigid
fixed timestep to this rate. Select `both` to include fractures, then map joints in the rigid solver's
`jointBreaks` setup or add a separate fracture producer. Each joint mapping provides its track, released
strain energy in J, effective mass in kg and optional fraction of that joint's energy (default 1).
`modalFractureImpulse` converts those values to an equivalent impulse for a fragment starting at rest.

The default sample rate is 48 kHz. Use `copyBlock(track)` for the latest world step or `copySince(cursor, track)`
to collect every retained sample after an advance. Keep one cursor per track. The default history is 0.25 s
and can be set with `historySeconds`. The cursor and sample rate let an offline mixer place blocks exactly
on its time line. The track data is a dry mono signal. Route audio buffers through Web Audio or
`@margoengine/audio` to apply gain, panning, occlusion and room effects.

The layout-1 f64 contact field has five words per track: normal impact impulse in N s, scrape power in W,
scrape power times speed, rolling proxy power in W and rolling power times speed. The layout-1 fracture field
has one equivalent impulse in N s per track. The PCM field publishes layout-1 f32 track rows with zero padding.
Its f64 clock field gives sample rate, first sample, valid samples, row capacity and track count.

## Drainage fog

`DrainageFog` is a shallow moist-air layer over a terrain grid. Clear-sky longwave loss and surface exchange cool the
air, which releases latent heat as droplets condense. Dense air accelerates downhill, and the wind carries the
vapour and fog across cell faces. Droplet settling, entrainment and open boundaries have a mass ledger.

```ts
import { DrainageFog } from '@margoengine/physics/drainage-fog';
import { PhysicsWorld } from '@margoengine/physics/world';

const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const fog = await DrainageFog.load();
world.add(fog, {
  width: 4, depth: 2, spacing: [8, 8],
  terrain: [3, 2, 1, 0, 3, 2, 1, 0], initialHumidity: 1, secondsPerSecond: 60,
});
world.advance(60);
console.log(fog.read(2, 1).extinction, fog.budget.deposited);
```

Inputs use SI units. `heat` supplies sensible heat to the layer in W/m² and `moisture` supplies water to the air in
kg/(m² s). Use the corresponding `SurfaceEnergySolver` words with `heat: { field, stride: 5, word: 1 }` and
`moisture: { field, stride: 3, word: 0 }` at load time. Use `followTerrain` to read a matching `TerrainBed`, or
provide the elevations directly. `wind` is a background `Wind` field sampled at each layer's centre.

`read(x, z)` gives temperature, motion, vapour and liquid mixing ratios, extinction and deposition. The layout-1 f64
`columnField` publishes the same cells in x-fast order. `opticalField` is `[ground, top, extinction, 0]` per cell as
f32. Readers can use the field registry or call `writeColumnData` for direct view binding. Pass the solver as
the source of Environment's optional `FogGrid`.

## Layered snowpack

`Snowpack` stores each column's snow mass, enthalpy and depth. Snow settles under its weight, conserves heat
between layers, retains liquid in its pores and drains meltwater into the ground. Wind moves surface snow and
builds a lee overhang at a steep edge. The same column publishes the weakest slope interface for an avalanche.

```ts
import { Snowpack } from '@margoengine/physics/snowpack';
import { PhysicsWorld } from '@margoengine/physics/world';

const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const snowpack = await Snowpack.load();
world.add(snowpack, {
  width: 3, depth: 3, cellSize: 4, origin: [-4, -4],
  layers: [{ mass: 50, density: 250, temperature: 273.15 }],
  topHeat: 250, secondsPerSecond: 3600,
});
world.advance(60);
console.log(snowpack.read(1, 1).mass, snowpack.read(1, 1).runoff);
```

Layers are given surface-first. Snowfall gets a dedicated surface layer. Mass rates use kg/(m² s), net surface and
basal heat use W/m² into the pack, and all temperatures use kelvin. For a real `TerrainBed`, load with `followTerrain`
and use the same cell counts, spacing and cell-centre locations. Port bindings may send one uniform row across the grid
or one row for each column. Bind `SurfaceEnergySolver.energyFluxField` as `topHeat` with `stride: 5` and
`weights: [1, -1, -1]` for net radiation minus sensible and latent losses. Supply the basal exchange separately.

- `runoffField` gives layout-1 f64 per-column liquid-equivalent m/s, accepted by `RainfallRunoff`'s rain input.
  `dischargeField` gives the same liquid in m³/s, accepted by `ShallowWaterSolver`'s mapped `outlets` input.
  Route each column to one receiver for a conserved watershed.
- `coverField` gives layout-1 f32 `[ground, snowDepth]` pairs. Pass `field: snowpack` to Weather's `Snow` and
  `snow: snowpack` to its `Avalanche`. The display uses the world snapshot's current cover and the slab is sampled at release.
- `columnField` gives layout-1 f64 rows of mass, liquid, temperature, depth, stability, slab depth, the X and Z overhang,
  overhang mass, unused heat, drained heat and slab mass. `read(column, row)` exposes the same values with units and
  `layer(column, row, layer)` gives the physical layer's mass, enthalpy and depth.

## Aeolian transport

`AeolianTransport` lifts loose sand or snow, transports it across a `TerrainBed`, and deposits it when the wind
falls below the impact threshold. Wind carries the grains downwind and steep faces relax toward repose. The
solver publishes moving mass, dust emission and the opposing stress on the wind. Its optional Wasm assets load
when `load()` is called. Length, velocity and mass use metres, m/s and kilograms.

```ts
import { AeolianTransport } from '@margoengine/physics/aeolian';
import { TerrainBed } from '@margoengine/physics/earth';
import { PhysicsWorld } from '@margoengine/physics/world';

const grid = { columns: 16, rows: 8, width: 16, depth: 8, centre: [0, 0] as const };
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const terrain = new TerrainBed();
const transport = await AeolianTransport.load();
world.add(terrain, { ...grid, elevations: (x) => Math.max(0, 0.3 - 0.1 * Math.abs(x)) });
world.add(transport, { grid, material: 'snow', frictionVelocity: [0.55, 0], open: { maxX: true } });
world.advance(180);
console.log(transport.sample(0, 0)?.mass, terrain.bed.sample(0, 0).elevation, transport.budget.outflow);
```

Use `wind` for a replayable `Wind` provider or declare a `frictionField` when loading the solver. For the latter,
each vertex stores `[uStarX, uStarZ, airDensity]` in f64 or f32. Pass `erodibility` or `erodibleField` to model soil
cover or wet areas. Start with `mobileDepth` matching the loose layer above bedrock (default 0.1 m). Vertex arrays
for this solver have X increasing fastest. `motionField` yields `[kg/m², m/s, m/s]`; `dustField` yields kg/(m² s)
and `windDragField` yields `[Pa on X, Pa on Z]`, all f64 layout 1. The optional `vfx/blown-sand` entry can use the
same solver as its `transport`, with a ground sampler from `terrain.bed`.
On a fine sand grid, set `ripples: { meanHop }` to include short splash hops that amplify a bed perturbation into an
impact ripple. `meanHop` is the mean hop length in metres. The other ripple coefficients default to an incident
cotangent of 4 and an ejection rate of `grainSpeed / 0.3` per second.

## Groundwater and springs

`@margoengine/physics/groundwater` evolves an unconfined water table with recharge, lateral Darcy flow, springs and
surface seepage. Spring and seepage volumes can enter the shallow-water solver on the same world clock.

```ts
import { type BedShape, TerrainBed } from '@margoengine/physics/earth';
import { GroundwaterSolver } from '@margoengine/physics/groundwater';
import { ShallowWaterSolver } from '@margoengine/physics/hydro';
import { PhysicsWorld } from '@margoengine/physics/world';

const grid: BedShape = { columns: 3, rows: 1, width: 3, depth: 1, centre: [0, 0] };
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const bed = new TerrainBed();
const aquifer = await GroundwaterSolver.load({ followTerrain: true });
world.add(bed, { ...grid, elevations: () => 0 });
world.add(aquifer, {
  grid,
  initialHead: -0.2,
  recharge: 0.01,
  springElevation: -0.5,
  springConductance: [0, 0.05, 0],
});
const stream = new ShallowWaterSolver('water', aquifer.shallowInput());
world.add(stream, { bed: bed.bed });
world.advance(60);
console.log(aquifer.read(1, 0), aquifer.budget, stream.volume());
```

The cell grid uses x-fast order. Default bottom and surface elevations are −10 m and 0 m. The starting head
fills 80% of that thickness, specific yield is 0.2, and horizontal conductivity is `1e-4` m/s. Set
`conductivityX` and `conductivityZ` to model direction-dependent flow. The default recharge and spring
conductance are both zero. A spring starts above its specified `springElevation`, which defaults to the
initial surface. `sideHeads` fixes absolute water levels on the specified sides. Other sides are impermeable.

Set `rechargeField: runoff.rechargeField` to connect HYDRO-02 soil drainage. Set `followTerrain` (default false)
to use the current terrain at each cell centre for surface seepage. `load` also accepts `id` (default `groundwater`)
and an abort `signal`. The linear solve defaults to a relative residual of `1e-12`.
`secondsPerSecond` defaults to 1. When accelerating underground time, outlet rates still describe volume per
world second so a receiving stream gets the actual exported volume. The model records total storage, recharge,
boundary inflow and outflow, spring discharge and seepage in cubic metres.

## Glacier and ice-sheet flow

`@margoengine/physics/glacier` advances grounded ice over a rectangular cell-centred bed. It solves
Glen shallow-ice flow, opens surface crevasses under tension, releases marine calving and dry icefall
volumes, and sends meltwater down a D8 surface drainage graph. Simulation runs on the world clock.

```ts
import { GlacierSolver } from '@margoengine/physics/glacier';
import { PhysicsWorld } from '@margoengine/physics/world';

const glacier = await GlacierSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(glacier, {
  nx: 3, nz: 2, dx: 100,
  bed: [80, 45, 0, 75, 40, -5],
  thickness: [90, 60, 20, 90, 60, 20],
  melt: 1e-8, timeScale: 86400,
});
world.advance(60);
console.log(glacier.sample(2, 1), glacier.budget);
```

Grid arrays are x-fast. Each cell is grounded (boundary 0), open water (1), or a dry cliff receiver
(2). Water and cliff receivers have no grounded ice or snowfall. Outer edges are closed to ice
transport. Unspecified thickness, accumulation, melt and crevasse water default to zero. The
default Glen exponent is 3 and the temperate rate factor is 2.4e-24 Pa⁻³ s⁻¹. Ice and water
densities default to 917 and 1000 kg/m³. Sea level defaults to 0 m, dz to dx, and timeScale to 1.
`GlacierSolver.load({ id, signal })` accepts an optional field prefix (default glacier) and cancellation.

All six published fields use layout-1 f64 cells. `thicknessField` and `crevasseField` are metres,
`velocityField` stores x and z component planes in m/s of simulated time, and `meltwaterField`
publishes m³ of liquid per world second at each outlet. Pass that descriptor and the appropriate
outlet indices to `ShallowWaterSolver`. `calvingField` and `icefallField` publish the ice volume
in m³ released during the current tick, at the source cell. They reset on the next step. Budget
volumes use ice density. Use the same climate and suitable time scales for physically linked solvers.

## Ground animal locomotion

`@margoengine/physics/locomotion` loads the optional Rust SIMD solver for a slithering snake, a lizard, an insect,
a spider or a sideways-moving crab. Choose one or mix the body types in a single `PhysicsWorld`. Give a legged body
its own hip locations, foot locations and phases to replace the preset gait.

```ts
import { GroundLocomotion } from '@margoengine/physics/locomotion';
import { PhysicsWorld } from '@margoengine/physics/world';

const gait = await GroundLocomotion.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(gait, {
  bodies: [{ kind: 'snake' }, { kind: 'insect' }, { kind: 'crab' }],
});
world.advance(60);
const snake = gait.read(0);
const frontFoot = gait.readContact(1, 0);
if (snake.position[2] <= 0 || !Number.isFinite(frontFoot.position[1])) {
  throw new Error('Expected the ground animal poses after one second.');
}
```

The plane starts at Y=0. To follow production terrain, pass the `TerrainBed` geometry as `bedShape` to
`GroundLocomotion.load`, and register the bed before the animals. Use the same `cellSize` as the world and set
`originCell` to the cell passed to `world.add` for an animal group that starts outside the origin cell. The `bed`
parameter accepts a fixed `Bed` and supplies a surface until a declared live port is available. The remaining static
fallback is `groundHeight`. The bed's border behavior follows `Bed`.

A snake has 32 links over 1 m by default. Its 0.48 rad bend and two waves advance at 1 Hz, with a 0.025 m belly
radius and forward, backward and sideways friction coefficients of 0.11, 0.14 and 0.19. The body receives no
horizontal thrust from its internal wave. Legged bodies derive target speed from `frequency × stride` and drive
through planted feet. Their default gait alternates diagonal pairs, tripods or tetrapods at a 0.58 duty factor.

| Preset | Legs | Mass (kg) | Hip length × width (m) | Rest leg (m) | Gait (Hz) | Direction |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Lizard | 4 | 0.035 | 0.11 × 0.04 | 0.06 | 3 | +Z |
| Insect | 6 | 0.003 | 0.037 × 0.015 | 0.023 | 6 | +Z |
| Spider | 8 | 0.02 | 0.048 × 0.034 | 0.045 | 4 | +Z |
| Crab | 8 | 0.06 | 0.052 × 0.08 | 0.048 | 4 | +X |

Legged defaults use 0.35 leg lengths of desired travel per cycle, 0.28 leg lengths of swing clearance, 4% stance
extension, 0.8 friction and a torso ground radius of 0.25 leg lengths. Zero `tractionResponse` and
`postureResponse` give passive spring legs. Zero `frequency` holds the configured pose phase. The solver derives
mass-based stiffness and damping from world gravity if omitted. Body and feet coordinates are in SI units,
Y up and +Z forward before applying heading.

`read` returns the current COM, velocity, quaternion and angular momentum. `readContact` returns the most recent
reaction force, stance couple, and link midpoint or foot position. For legged animals, the torso contact is the last
row after the configured feet. For a snake, each row's axis points from tail toward head. Its link endpoints are
the midpoint plus and minus half a link length along that axis. Consumers can read the versioned
`GROUND_POSE_FIELD` and `GROUND_CONTACT_FIELD` directly through the world registry. Contact rows are grouped by
body order and report the samples that produced the last substep. The entry fetches Wasm on `load`, and accepts
an abort signal.

## Material ageing

MaterialAgeingSolver advances rust, copper patina, wood rot, marine fouling and carbonate stone recession
on the physics clock. A wreck can use metal patches with different immersion and surface exposure.
Read a patch's remaining thickness for geometry or integrity logic and its appearance for an existing PBR material.

```ts
import { PbrMaterial } from '@margoengine/core';
import { AGEING_YEAR, MaterialAgeingSolver } from '@margoengine/physics/ageing';
import { PhysicsWorld } from '@margoengine/physics/world';

const world = new PhysicsWorld({ rate: { num: 24, den: 1 } });
const ageing = new MaterialAgeingSolver();
world.add(ageing, {
  timeScale: AGEING_YEAR,
  exposure: { temperature: 293.15, relativeHumidity: 0.8, sulphurDioxide: 7, chloride: 25 },
  patches: [
    { material: 'copper' },
    { material: 'steel', thickness: 0.003, exposure: { submerged: 1 } },
  ],
});
const copper = new PbrMaterial(ageing.appearance(0));
world.advance(30 * 24);
copper.set(ageing.appearance(0));
const wreck = ageing.read(1);
if (wreck.fouledFraction <= 0 || wreck.consumedThickness <= 0 || copper.data[5]! >= 1) {
  throw new Error('The material should show ageing. Advance the world and use the solver appearance.');
}
```

The default time scale is one environmental second per world second. Use `AGEING_YEAR` to
advance one model year per world second. Each patch can scale that duration with `exposureMultiplier`
(default 1). Metal starts 0.01 m thick. Pine sapwood and limestone start 0.05 m thick.
Use `initialLoss`, `initialRotActivity` and `initialCover` to start with an older patch. All default
to zero. For metal, pre-existing loss seeds the atmospheric loss curve. Corrosion products are
fully retained by default. Set `coatingRetention` to represent partial retention and
`copperInnerScale` to change the copper substrate depth at which cuprite saturates (default 8 µm).

Ambient defaults are 293.15 K, 70% relative humidity, 4 mg/(m² day) SO₂ and 3 mg/(m² day)
chloride deposition. Rain defaults to 0.8 m/year at pH 5.6 and dry carbonate recession is zero.
Submersion defaults to zero, and immersion current defaults to the carbon-steel equivalent
of 60 µm/year. Specify current density in A/m² for the actual alloy and water chemistry.
Default full-supply recruitment is 0.01 per day. Wet and dry removal default to 0.002 and 0.05 per day.
Larval supply defaults to 1.

For changing exposure, construct `new MaterialAgeingSolver({ readExposure: true })`
and publish to its `exposureField`. Use `writeAgeingExposure` to fill one layout-1 f64 broadcast
row or one row per patch. Row order is temperature in K, RH fraction, SO₂ and chloride in mg/(m² day),
immersed fraction, incident rain in m/s, rain pH, corrosion current in A/m², dry carbonate recession in
m/s and larval supply fraction. Fixed exposure defaults remain available before a producer's first tick.
The solver's default ID and field prefix are `ageing`. Choose a separate `id` per group in one world.
Its `stateField` has layout-1 f64 rows holding remaining and consumed metres, total and inner
coating metres, rot activity, fouled fraction and environmental seconds.

## Iceberg capsize and calving

`@margoengine/physics/iceberg` simulates cuboid icebergs in six degrees of freedom. The pressure
on their cut waterplane drives roll and heave. Current, wind and wet-face ablation update the pose
and scale. The optional wake reader takes displaced water in surface patches with zero net volume.

```ts
import { IcebergSolver } from '@margoengine/physics/iceberg';
import { WakeSolver } from '@margoengine/physics/sea';
import { PhysicsWorld } from '@margoengine/physics/world';

const ice = await IcebergSolver.load();
const wake = new WakeSolver('iceberg-wake', ice.wakeSourceField);
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
  .add(wake, { cells: [48, 48], cellSize: 0.5, sponge: 6 })
  .add(ice, { bodies: [{ size: [1, 4, 8] }], basalMelt: 0.001 });
world.advance(1200);
console.log(ice.sample(0), ice.budget, wake.sample(3, 0));
```

For actual marine release, use `IcebergSolver.load({ calving: glacier.calvingField })` and add
`releaseSites` with the glacier cell index and local x,z coordinates. Each site admits volumes to
its reusable body rows and retains excess events in its pending budget. Its default shape ratio is
[1,2,2], with one reusable row per site. Choose more rows for overlapping events.

Options default to ice 917 kg/m³, seawater 1025 kg/m³, air 1.225 kg/m³, sea level 0 m, still air and
water, face drag coefficients of 1, and zero recession. An unstable upright body without an authored
orientation receives a 0.001 rad seed heel around its less stable axis. An authored quaternion
takes precedence. `sample` gives the centre, orientation, velocity, angular velocity in body axes
and current geometry for rendering. `meltwaterField` carries freshwater in m³/s.

The wake field contains paired layout-1 f64 SeaSource rows [x, z, radius, pressure, volume]. Bind it
in the second argument of `WakeSolver`, with both solvers at 60 Hz in the same world cell. It works
alongside `WakeParams.sources`. Read the result in `SpectralSea` or render it with `WaterWake`.

## Grounded biped and quadruped gait

`@margoengine/physics/legged` drives a biped or quadruped from planted feet, spring support and limited ground
traction. It chooses footfall cadence and duty from the speed that was actually reached. Fast quadruped gaits use
diagonal or asymmetric contacts, and an unloaded foot applies no force.

```ts
import { LeggedLocomotion } from '@margoengine/physics/legged';
import { PhysicsWorld } from '@margoengine/physics/world';

const legs = await LeggedLocomotion.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(legs, {
  bodies: [{ kind: 'biped' }, { kind: 'quadruped' }],
});
legs.setTarget(0, { speed: 1.3, heading: 0 });
legs.setTarget(1, { speed: 3.5, heading: 0 });
world.advance(240);
console.log(legs.read(0).gait, legs.readContact(1, 0).force);
```

The optional entry shares the ground animal kernel, which loads on demand. Masses default to 75 kg and 500 kg.
Rest legs default to 0.9 m and 1.08 m. The default friction coefficient is 0.6. Each body's configured carried
mass is included in its inertia. Contact points, force, supported couple and stance are returned per foot, followed
by the torso. The pose and gait are also published in the world registry. Use `bedShape` and a registered
`TerrainBed` for live terrain.

For a rigid platform, give `load` a `deck` with the rigid body row, its full local X/Z dimensions and the local Y
level of its top. Add the `RigidSolver` first, then add the legged solver and call
`world.couple(['rigid', 'legged-locomotion'], 'staggered')`. Rigid motion is sampled through the body's canonical
port. Planted feet follow the support velocity and the legged solver returns the opposite force and moment as an
impulse to that same body. A fixed `bed` or `groundHeight` supplies the fallback outside the deck.

Enable `readIntent` to receive f64 pairs of desired speed and heading. Enable `readLoad` to receive f64 triples of
external force in newtons at the COM. Both use the documented layout and body-row order. The built-in target lives
in world snapshots. Use the public pose, gait and foot readings to place a rig.

## Pack ice and floes

Use `@margoengine/physics/pack-ice` for freely drifting sea-ice disks that collide, raft thin ice and turn
thicker broken ice into pressure ridges. The state keeps the volume of level, rafted and ridged ice.
The optional Water ice entry can display those poses on a sampled sea.

```ts
import { PackIceSolver } from '@margoengine/physics/pack-ice';
import { PhysicsWorld } from '@margoengine/physics/world';

const pack = await PackIceSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(pack, {
  restitution: 0,
  floes: [
    { position: [-1.015, 0], velocity: [2, 0], radius: 1, thickness: 0.08 },
    { position: [1.015, 0], velocity: [-2, 0], radius: 1, thickness: 0.08 },
  ],
});
world.advance(1);
console.log(pack.sample(0).raftedVolume);
```

Supply a pure shared `Wind` and water `FlowField` for weather and current. Registered producers can instead
publish `windField` or `currentField` with one layout-1 f64 row of X velocity, Z velocity and density per
floe. `floeField` publishes layout-1 records in `PACK_ICE_WORDS` order. Lengths, masses, angles and clock
values are in SI units. Change the world cell and use the same `cellSize` for every participating field.

For a live ship, load with `{ rigid: true }`, pass a waterline capsule for each vessel body row, and
put `pack-ice` and `rigid` in a staggered group. Add `hull` to that group when SEA-08 provides buoyancy.
Its body pose pushes the ice. The same contact sends the opposite linear and yaw impulse to the rigid
body through `bodyImpulses`. `vesselImpulse(row)` reports the signed contact impulse of the current
step. Use the same `rigidCapacity` as any other contributor to `bodyImpulses`.

## Ductile crashworthiness (`@margoengine/physics/crush`)

`resolveCrush` inverts a measured normal force-displacement curve to find the peak force, permanent stroke, and energy left for rebound. Use newtons, metres, kilograms, and metres per second. Positive hardening raises the yield force as the member permanently shortens. After the measured stroke is used, a stiffer elastic backing supports the load.

```ts
import { resolveCrush } from '@margoengine/physics/crush';

const curve = { stiffness: 400, yieldForce: 40, stroke: 0.4 };
const result = resolveCrush(curve, 4, 2);
if (Math.abs(result.absorbedEnergy - 6) > 1e-12) throw new Error('Expected 6 J of permanent work');
```

`CrushSolver` couples a list of known contact patches to a `RigidSolver`, including fixed barriers. Use body-local anchors for moving patches. Fix a barrier in the zero cell or give its cell and set `cellSize`. Match `bodyCapacity` to the rigid port and register both solvers in a `staggered` group. Let the crush patch own the contact event by using sensor colliders or filtering the selected rigid pair. The normal and point impulses are equal and opposite on moving pairs. The descriptor `damageField` publishes layout-1 f64 rows in input order. Each row contains permanent stroke (m), cumulative absorbed work (J), last peak stroke (m), force (N), impulse (N s), elastic work (J), seal loss (0–1), and impact count. `read()` copies the corresponding typed record.

```ts
import { Physics } from '@margoengine/physics';
import { CrushSolver } from '@margoengine/physics/crush';
import { PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';

await Physics.load();
const gravity = [0, 0, 0] as const;
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(false) });
using physics = new Physics(null, { arena: world.arena, gravity });
const cart = physics.addBody(null, {
  position: [-0.5, 0, 0], linearVelocity: [2, 0, 0],
  colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], mass: 4 },
});
const crush = new CrushSolver();
const bodyCapacity = physics.kernel.capacity;
world.add(new RigidSolver(), { physics, capacity: bodyCapacity });
world.add(crush, { bodyCapacity, patches: [{
  body: cart.row, anchor: [0.2, 0, 0], normal: [1, 0, 0], radius: 0.12,
  support: { point: [-0.2, 0, 0] }, material: { stiffness: 400, yieldForce: 40, stroke: 0.4 },
}] });
world.couple(['rigid', crush.id], 'staggered');
world.advance(12);
if (crush.read(0).impacts !== 1) throw new Error('Expected one barrier contact');
```

## Thin films on glass and ground

Use `@margoengine/physics/thin-film` for a thin layer of water on a backing surface. The solver tracks
rainfall, impacts, gravity, pressure, viscous shear, capillarity, drying and liquid leaving an open edge.
The first two axes define the patch in metres. Set its origin and tangents in a rigid body's local frame
and pass a body row to move it with a window or deck.

```ts
import { PhysicsWorld } from '@margoengine/physics/world';
import { ThinFilmSolver } from '@margoengine/physics/thin-film';

const film = await ThinFilmSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(film, {
  cells: [4, 6],
  spacing: 0.04,
  u: [1, 0, 0],
  v: [0, -1, 0],
  depth: 0.0002,
  drains: [false, false, false, true],
});
world.advance(60);
console.log(film.budget.dripped, film.sample(0, 5).depth);
```

Pass a `Precipitation` field for rain arriving at the moving panel and a `Wind` for surface shear.
A registered rain input can instead publish m/s as a scalar or per cell. The optional `impacts` input
publishes layout-1 f64 rows of U, V, radius, deposited m³ and inward impact speed. A tick is consumed
once, even when a slower writer's last value is held. Pass `waveSources: true` and give `film.waveField`
to the local `WakeSolver` for pressure pulses on a wet platform in the same cell. The film retains
the deposited water and the wake receives the normal impulse.

Use `depths()` for a render texture, `filmField` to consume substrate, depth and drip records, and
`dripsField` for cell discharge in m³/s. The options document the default water and wall properties.

## Windborne dust, mist and sea spray

`@margoengine/physics/airborne` moves individual environmental parcels using local wind, diameter-dependent
drag, gravity and evaporation. Read the poses for scene particles and the ledger for mass accounting.

```ts
import { AirborneParticles } from '@margoengine/physics/airborne';
import { PhysicsWorld } from '@margoengine/physics/world';

const particles = await AirborneParticles.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(particles, {
  capacity: 128,
  initial: [{ kind: 'freshwater-mist', diameter: 0.00008, mass: 0.00001, position: [0, 1, 0] }],
  wind: {
    medium: 'air',
    cell: [0, 0, 0],
    sample: () => ({ velocity: [3, 0.3, 0], density: 1.225, temperature: 288.15 }),
  },
  humidity: 0.98,
});
world.advance(30);
console.log(particles.readParticles(), particles.budget);
```

Enable `terrain` and match the actual `TerrainBed` grid for world-space deposition. Pass
`dustField: aeolian.dustField` to receive mineral dust emitted by EARTH-07. Enable `whitecaps` with the
matching SEA-13 grid in `spray` to turn active whitecaps into three measured-source diameter bands.
Supply `sources` for existing waterfall mist or mineral footstep dust. If `emissions` is enabled, an
optional source owns one layout-1 f64 kg/s value for each row. Closed mass accounting includes the
discrete parcels, waiting source mass, vapour, settled mass and open outflow.

## Acoustic pressure in rooms and tunnels

Use `@margoengine/physics/room-sound` for low-frequency pressure over an indoor air grid. Solid cells shape the room
and the air-cell reflection values set its wall impedance. Blocks from `readTrace()` contain ordered pressure samples
and their sample rate. Concatenate consecutive blocks to measure a room response with `roomEnergyDecay()`.

```ts
import { RoomSoundSolver } from '@margoengine/physics/room-sound';
import { PhysicsWorld } from '@margoengine/physics/world';

const room = await RoomSoundSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(room, {
  grid: { dimensions: [24, 12, 16], spacing: 0.25, reflection: 0.8 },
  source: [3, 2, 5],
  receiver: [17, 3, 5],
});
world.advance(10);
console.log(room.readTrace());
```

The same entry traces exact early reflected paths from finite planar surfaces. The path points can drive a
visual cutaway, and the signed pressure gains can drive a Web Audio convolver.

```ts
import { acousticBox, createRoomConvolver, roomArrivals } from '@margoengine/physics/room-sound';

const context = new OfflineAudioContext(1, 2048, 48000);
const arrivals = roomArrivals({
  source: [2, 1, 3],
  listener: [5, 1, 3],
  surfaces: acousticBox([0, 0, 0], [8, 4, 6], [0.9, 0.8, 0.6]),
});
const convolver = createRoomConvolver(context, arrivals);
const signal = context.createBuffer(1, 1, context.sampleRate);
signal.getChannelData(0)[0] = 1;
const source = context.createBufferSource();
source.buffer = signal;
source.connect(convolver).connect(context.destination);
source.start();
const output = await context.startRendering();
if (!output.getChannelData(0).some((pressure) => pressure !== 0)) {
  throw new Error('Room response is silent. Check the arrival paths.');
}
console.log(arrivals[0]?.points);
```

The wave grid and early-path surface list use separate scene descriptions. Both can be built from one game level.
Set `excitation: true` if a world producer writes pressure increments, then publish a single impulse per world
step or one increment for each internal sample in a layout-1 f64 port. `pressureLayout` gives the native region's
voxel strides. Browser or Node callers can cancel the optional asset load with an AbortSignal.

## Three-dimensional viscoplastic flow

Use `@margoengine/physics/viscoplastic` for material with a yield stress, including mud, thick paint
and wet concrete. Material points exchange momentum with the grid, carry elastic deformation below
yield and flow above it. Use exponent 1 for Bingham flow, lower values for shear thinning and higher
values for shear thickening. Zero yield stress allows flow at any nonzero shear.

```ts
import { ViscoplasticSolver } from '@margoengine/physics/viscoplastic';
import { PhysicsWorld } from '@margoengine/physics/world';

const mud = await ViscoplasticSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(mud, {
  cells: [8, 8, 8],
  spacing: 0.08,
  yieldStress: 25,
  exponent: 0.65,
  points: [
    { position: [0.27, 0.30, 0.27], volume: 0.00005 },
    { position: [0.35, 0.30, 0.35], volume: 0.00005 },
  ],
});
world.advance(6);
console.log(mud.budget.storedReferenceVolume, mud.sample(0).position);
```

Pass the geometry of a registered `TerrainBed` to `load({ terrain })` to collide with the live bed.
For an inlet, pass a field descriptor to `load({ inlet })` and reserve `capacity` for the material
points. The layout-1 f64 inlet rows are position XYZ, velocity XYZ and m³/s. An open face lets
material leave and frees its point row for the next inlet sample. The reference volume is mass
divided by rest density. The current volume also includes elastic compression.

`pointField` publishes `VISCOPLASTIC_WORDS` layout-1 f64 values per allocated point, including
position, velocity, current volume, pressure, shear stress, plastic shear and presence. Draw only
the present points. `solventViscosity` adds implicit Newtonian diffusion to the material's plastic flow.

### Measured wheel contact materials

`VehicleOptions.groundMaterial` samples the collider, point, normal, radius and width from each actual wheel hit. Return `{ grip }` to limit the combined tyre force by the measured friction coefficient times normal load. Return `{ grip, soil: { stiffness, exponent, area } }` to let a loaded wheel sink into yielding ground. These values are pressure stiffness in Pa/m^exponent, the dimensionless exponent and measured footprint area in m². `vehicle.wheelGround(index)` reads the last applied grip and sinkage. `groundReaction: true` includes the moving support's point velocity and exchanges equal and opposite impulses with its dynamic body. The Road driving entry provides registered materials and banked road colliders.

`Vehicle.writeMotionState()` and `readMotionState()` preserve attachment controls, wheel spin and transmission state in a buffer of `motionStateWords` f64 values. RoadDriver stores that buffer in the world arena when bound to a vehicle. Use the methods with a solver-owned arena region for custom vehicle attachments that need deterministic seek.

## Natural long waves and coastal run-up

Use `@margoengine/physics/tsunami` for long gravity waves over a wet and dry bathymetry grid. The
solver gives water depth, surface height, discharge, maximum depth and the first wet time per cell.
The same world clock advances the source and the waves over the shore.

```ts
import { PhysicsWorld } from '@margoengine/physics/world';
import { TsunamiSolver } from '@margoengine/physics/tsunami';

const pulse = await TsunamiSolver.load();
const depth = Array.from({ length: 96 }, (_, x) => -1 + Math.max(0, x - 36) / 28);
const surface = Array.from({ length: 96 }, (_, x) => (x >= 18 && x < 30 ? 0.06 : 0));
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(pulse, {
  cells: [96, 1],
  spacing: 0.25,
  bathymetry: depth,
  surface,
  dischargeX: surface.map((h) => Math.sqrt(9.80665) * h),
  manning: 0.012,
});
world.advance(60);
console.log(pulse.sample(36, 0).depth, pulse.budget.runup);
```

Pass a live `TerrainBed` geometry or an aligned layout-1 `bottomField` to supply natural seabed
motion. An optional `bottomFilterDepth` redistributes the rapid bottom response over nearby wet
cells and preserves water volume. For a calving or slide pulse, pass its 60 Hz `SeaSource` descriptor
in `sources`. Each fresh publication supplies its signed displacement volume exactly once, while
the pressure is held over the contributing interval. The glacier and iceberg example in the
coupling tests drives this route from the real ICE-02 release.

Read `inundationField` in `TSUNAMI_WORDS` order and use `travelTimes([x, z])` for the static wet
patch's arrival estimate. `landslideImpulse()` evaluates Heller and Hager's near-field crest
estimate for a natural subaerial slide in a channel.

## Viscous accretion and Kerr trajectories

Use `@margoengine/physics/accretion` to evolve a thin viscous disk around a fixed star or black hole. Supply its
annulus edges in metres, mass in kilograms, viscosity in m²/s and initial surface density in kg/m². The inner
edge defaults to zero torque and accretes gas. The outer edge defaults to sealed and can receive a feed in kg/s.
`ring(i)` reads its inward mass flow, orbital phase and one-face radiation flux. `budget()` reports kilograms
and the total luminosity in watts. An optional external field can add a layout-1 f64 feed, in kg/s.

```js
import { AccretionDiskSolver, KerrGeodesicSolver, kerrCircularOrbit } from '@margoengine/physics/accretion';
import { PhysicsWorld } from '@margoengine/physics/world';

const centralMass = 2e35;
const disk = await AccretionDiskSolver.load();
const tracer = new KerrGeodesicSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
  .add(disk, {
    centralMass,
    edges: [1e9, 1.2e9, 1.5e9, 2e9],
    initialDensity: [3, 7, 2],
    viscosity: 1e13,
  })
  .add(tracer, { ...kerrCircularOrbit(10, 0.3), centralMass, radius: 10, spin: 0.3 });
world.advance(60);
console.log(disk.ring(0).heating, tracer.sample().azimuth);
```

The disk uses Newtonian rotation and a prescribed viscosity. The independent relativistic tracer advances in
exterior observer time. It supports Kerr, Schwarzschild, inclined and eccentric trajectories and `tracer: 'light'`
for null geodesics. Its input radii use `GM/c²`. Output distances and proper time use metres and seconds. The
options default to 60 physics updates per second and an RK4 phase increment of 1/32 at the start of each tick.
The disk publishes density, heating and orbital phase in increasing radial order.

## Synoptic weather, fronts and mountain precipitation

`SynopticWeather` evolves regional vorticity, column vapour, cloud water, falling condensate and temperature in a
fixed map frame. It publishes wind, pressure, altitude-adjusted air temperature, precipitation and integrated vapour
transport. The atmosphere and its water budget share the PhysicsWorld clock.

```ts
import { SynopticWeather } from '@margoengine/physics/synoptic';
import { PhysicsWorld } from '@margoengine/physics/world';

const weather = await SynopticWeather.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(weather, {
  cells: [32, 16],
  spacing: [50_000, 50_000],
  meanWind: [20, 0],
  timeScale: 1200,
  vapour: (x, z) => (x < 350_000 && z > 200_000 && z < 350_000 ? 28 : 10),
});
world.advance(30);
console.log(weather.sample(400_000, 250_000).ivt, weather.budget);
```

The grid defaults to 32 by 32 with 80 km square cells. Choose power-of-two extents and place weather features
through the initial fields in `SynopticParams`. The default latitude is 45° north and the mean wind is 12 m/s east.
Use the high tier for limited higher-order transport, curved-flow pressure and a Fourier terrain-wave uplift
correction. The fast tier uses first-order upwind transport, geostrophic pressure and direct upslope motion.
The default condensed-water conversion and fallout times are 1000 s. Supply a `TerrainBed` for the orographic model.
Set `timeScale` for a time lapse. Rates and the water ledger refer to physical weather seconds.

Set `layers: { upperMeanWind: [30, 0] }` in the high tier to evolve a sheared atmosphere. `sampleLayers()` reads
both streamfunctions and winds and the temperature anomaly from pressure-level thickness. The default 200 km
deformation radius sets the separation of barotropic and baroclinic modes. Wind interpolates between 1500 and 5500 m
by default. The weather and water readers use the winds from the same physical frame.

`wind` is the existing `Wind` contract for a cloud box or other atmospheric reader. `rainSource()` supplies surface
mm/h to `PrecipitationField`. Set its `base` just above the ground when the upstream physics has already accounted for
fallout. Load with `{water: true}` and pass the grid of a `ShallowWaterSolver` to accumulate pressure gradients and wind
stress on it. Arrange the pair in a staggered coupling. `@margoengine/weather/synoptic` adapts the same solve for Sky.

## Natural lightning and thunder

`LightningSolver` advances a single cloud-to-ground leader in the electric field above a flat plane or a sampled
`TerrainBed`. It publishes the return path, forks and timed thunder segments when the leader makes contact.
Pass the resulting channel to Sky's `LightningBolt` and pass the source positions to `OutdoorSound` for propagation.

```ts
import { LightningSolver } from '@margoengine/physics/lightning';
import { OutdoorSound } from '@margoengine/physics/outdoor-sound';
import { PhysicsWorld } from '@margoengine/physics/world';

const rate = { num: 60, den: 1 };
const lightning = await LightningSolver.load();
const world = new PhysicsWorld({ rate }).add(lightning, {});
world.advance(30);
const sources = lightning.thunder();
const sound = new OutdoorSound();
const acoustics = new PhysicsWorld({ rate }).add(sound, {
  links: sources.map(({ position }) => ({ source: position, listener: [2000, 2, 480] })),
});
acoustics.advance(1);
const arrivals = sources.map(({ emissionTime }, index) => emissionTime + sound.read(index).delaySeconds);
console.log(lightning.flash, lightning.channel().trunk, Math.min(...arrivals));
```

The default grid is `13 × 19 × 13` with 80 m spacing above the origin and an upper plane at −100 MV. The cloud seed
starts at the centre of the top plane at world time zero. The default leader and return speeds are 200,000 and
100,000,000 m/s. Growth weights scale with the square of the normalized voltage difference. `charge` samples a
static free charge density in C/m³. The dimension-dependent default sweep count targets a normalized potential
correction of `1e-6`, exposed as `residual`. `brightness(time)` gives the relative return envelope with a 10 µs
rise and a 50 ms fade by default. A `bed` in another cell uses `cell` and `cellSize` (default 4096 m) to align the
samples. Pass the same initial `cell` to `world.add()` if the grid is outside the origin cell.

`channelField` has a header `[segment count, trunk count, ...]` in one `LIGHTNING_CHANNEL_WORDS` f32 row, followed by
the trunk polyline and branches. `thunderField` has one `LIGHTNING_THUNDER_WORDS` f64 header row with the source count,
followed by source XYZ (m), emission time (s), relative weight and segment length (m). Apply source emission time
before acoustic flight time. `channel()` and `thunder()` return copies of their active data.

## Natural lava flow and coastal displacement

`@margoengine/physics/lava` advances a vent-fed lava sheet on the PhysicsWorld clock. It transports mass and enthalpy, grows stationary crust, follows slopes and channels, and stops sub-yield flow. It can sample a live `TerrainBed` and publish the volume entering the sea to `TsunamiSolver`.

<!-- example: natural-lava-flow -->
```js
import assert from 'node:assert/strict';
import { LavaSolver } from '@margoengine/physics/lava';
import { TsunamiSolver } from '@margoengine/physics/tsunami';
import { PhysicsWorld } from '@margoengine/physics/world';

const cells = [16, 2];
const bed = Array.from({ length: 32 }, (_, i) => (i % 16 < 6 ? 0.2 : -0.75));
const lava = await LavaSolver.load();
const sea = await TsunamiSolver.load({ sources: [lava.seaSourceField] });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
  .add(lava, { cells, spacing: 1, bed, seaLevel: 0, vents: [{ cell: [5, 0], flow: 2.5, end: 1 }] })
  .add(sea, { cells, spacing: 1, bathymetry: bed });

world.advance(120);
assert.ok(lava.sample(7, 0).depth > 0);
assert.ok(sea.budget.admittedSourceVolume > 0);
```

Grid records are f64 in layout 1, with X fastest. `lavaField` exposes lava depth (m), bulk and skin temperature (K), crust thickness (m), X and Z discharge (m²/s), surface altitude (m) and enthalpy (J/m²). `depositField` provides ground plus solid crust altitude (m). Use `id` to name independent deposits, and match the receiving grid and origin. `seaSourceField` uses the same layout as water-entry and calving sources. Its signed volume is the change in submerged lava occupancy at each tick. With `seaLevel` omitted, the solver runs a terrestrial patch.

For contact with ice, load with `exchangeIce: true`, map distinct lava cells to the `IceSolver` site's order and area with `ice`, and use a 60 Hz staggered group `.couple(['lava', 'ice-thermodynamics'], 'staggered')` with `new IceSolver({ readHeat: true })`. Heat used by the ice is removed from lava enthalpy. Drainage and steam mass are reported by both sides. The included `LavaBudget` records supplied and stored lava volume, environmental and ice heat, and displaced water.

### Position-based water for interactive pours and splashes

`@margoengine/physics/pbf` advances a free-surface liquid on the physics clock. Its sparse native neighbour search
works in local cell coordinates. Choose `fast` for four density projections per advective substep or `precise`
for twelve. Both profiles solve positive pressure at open interfaces. The optional `cohesive` setting restores
the signed constraint for stylized sheets and droplets.

```ts
import { PbfSolver } from '@margoengine/physics/pbf';
import { PhysicsWorld } from '@margoengine/physics/world';

const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const liquid = await PbfSolver.load(world.memory);
const spacing = 0.06;
const particles = Array.from({ length: 128 }, (_, i) => ({
  position: [spacing * (0.5 + i % 4), spacing * (0.5 + Math.floor(i / 16)), spacing * (0.5 + Math.floor(i / 4) % 4)] as const,
}));
world.add(liquid, { particles, spacing, profile: 'fast', bounds: [[0, 0, 0], [1.2, 1, 0.5]] });
world.advance(18);
console.log(liquid.mass, liquid.sample(0).position, liquid.statistics.peakCompression);
```

Pass `liquid.positions()` to `ParticleLiquid.attach` in `@margoengine/water/liquid`. For live rendering, allocate
one `Float32Array` of `3 * capacity`, write to it with `positions(out)` and call the effect's `update` with the
current active count. `particleField` publishes the versioned f64 rows with XYZ, velocity XYZ, density and mass.
Zero mass marks a reserved inactive row. Reserve `capacity` and call `emit` on a tick boundary for a continuous
pour into the same arena. The standalone browser fixture shows the solved water surface and its measured motion.

Use `boundaries` for a fixed box, sphere or capsule, or attach the shape to a `RigidSolver` body row with `rigid: true`.
PBF sizes its impulse field from the whole world's row count. Use `world.couple(['rigid', liquid.id], 'staggered')` for body-driven obstacle motion
and paired linear and angular reactions. The solver reads local coordinates from the body's owning cell. Set the
same `cellSize` on both sides of a floating-origin scene.

### Rail running gear and contact wire

Import `@margoengine/physics/rail` for railway rolling stock with two sprung bogies, four wheelsets,
wet adhesion, traction, braking and wagon connections. Give `RailRoute` SI track stations.
Positive cant lowers the right rail viewed in increasing arclength. The two optional rail heights
describe local roughness above that common banked plane. Use `railRouteAtSwitches` to resolve
authored turnout alignments before the train runs.

```ts
import { RailRoute, RailSolver } from '@margoengine/physics/rail';
import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';

const track = new RailRoute([
  { centre: [0, 0, 0] }, { centre: [0, 0, 24] }, { centre: [0, 0, 64] },
]);
const world = new PhysicsWorld({
  rate: { num: 60, den: 1 }, gravity: [0, -9.80665, 0], memory: worldMemory(false),
});
const rail = await RailSolver.load(world.memory);
world.add(rail, {
  cars: [{ track, distance: 12, speed: 6, wetness: 0.65 }],
  wire: { track, pantographs: [{ car: 0, energized: true }] },
});
world.advance(60);
const car = rail.read(0);
const head = rail.readPantograph(0);
const wire = rail.readWire(car.distance);
if (car.distance < 17 || car.wheelsets[0].angle <= 0 || head.headHeight <= 4 || wire.height <= 4) {
  throw new Error('Expected the rail car and contact head to advance along the wire');
}
```

Use `new RailSolver()` for cars without a catenary. For a wire, `RailSolver.load(world.memory, options, signal)`
fetches the SIMD module for that world's memory mode. `setControls(index, {drive, brake})` updates held
torque commands in snapshot memory. A consumer can apply `read(index)` to a model using the car's
position, forward, up, the two bogie deflections, and the four axle angles. `readPantograph` gives the
head height, normal force, gap and a short visual arc pulse on powered separation. A catenary carries
mechanical waves and contact impulses. The arc pulse is an animation event.

| Car setting | Default |
| --- | --- |
| Sprung carbody, each bogie, each wheelset | 24,000 kg, 2,000 kg, 650 kg |
| Contact gauge, wheel radius, conicity | 1.435 m, 0.35 m, 0.045 |
| Bogie spacing, axle spacing, body centre height | 6.6 m, 1.85 m, 1.05 m |
| Primary spring and damper per axle | 750 kN/m, 9 kN·s/m |
| Secondary spring and damper per bogie | 190 kN/m, 16.5 kN·s/m |
| Hertz and creep stiffness | 100 MN/m^(3/2), 600 kN per unit creepage |
| Flange clearance, supported half tread, flange stiffness | 8 mm, 52 mm, 3 MN/m |
| Drive and brake torque limits per axle | 1,600 and 2,200 N·m |
| Dry and wet peak adhesion | 0.32 and 0.12, adjustable from measurements |
| Initial speed and local wetness | 0 m/s and 0 |

Draft gear defaults to 30 mm of slack, 450 kN/m tension stiffness, 820 kN/m buffer stiffness and
21 kN·s/m damping. The wire defaults to 32 m spans, 12 intervals per span, 5.1 m support height,
0.1 m alternating lateral stagger, 12.5 kN tension, 1.05 kg/m density and 1/s damping.
The head defaults to 4.1 m above the carbody centre, 8 kg, 95 N uplift, 2,300 N/m spring,
55 N·s/m damping, 26 kN/m contact stiffness, a 0.5 m shoe half width and shoe friction 0.15.
The head can be offset longitudinally. Powered arc display is opt-in and defaults to a 12 mm
gap window and 1/60 s display duration.

`carField` provides layout-1 f64 records with `RAIL_CAR_WORDS` words per car. Words 0–11 contain
arclength, speed, sway and sway speed, heave and heave speed, roll and roll speed, pitch and pitch
speed, and longitudinal and lateral wheel loads. Words 12–23 hold two bogies with heave, sway,
yaw and their rates. Words 24–30 hold controls, support flags, coupler loads and roof reactions.
Words 32–55 hold the four wheelsets with angle, angular speed, heave, heave speed and left/right
rail loads. `wireField` holds interleaved lateral/vertical displacement and velocity columns,
followed by seven head words each. World snapshots preserve the commands, spring and axle state,
wire motion and arc pulse.

## Soil tracks, footprints and airborne fines

Use `@margoengine/physics/terramechanics` to apply a measured wheel, belt, shoe or hoof load to a live
`TerrainBed`. The solver distributes the displaced material into compaction, berms and dry mineral fines.

```ts
import { TerrainBed } from '@margoengine/physics/earth';
import { Terramechanics } from '@margoengine/physics/terramechanics';
import { PhysicsWorld } from '@margoengine/physics/world';

const terrain = { columns: 24, rows: 24, width: 2.4, depth: 2.4, centre: [0, 0] as const };
const bed = new TerrainBed();
const soil = await Terramechanics.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
  .add(bed, { ...terrain, elevations: () => 0 })
  .add(soil, { terrain, patches: [{ x: 0, z: 0, length: 0.25, width: 0.12, load: 500 }] })
  .couple(['terramechanics', 'bed'], 'staggered');
world.advance(30);
console.log(soil.read(0).sinkage, soil.budget.removed, bed.elevations()[312]);
```

For a vehicle, use `soilPatchField()` for the matching `Terramechanics.load({ input })` and
`SoilContactRigidSolver(input, { terrain })`. Give the rigid adapter its running attachments, per-wheel or
per-belt footprint sizes and `{ ground: new BedCollider(physics, bed.bed) }`. Couple `rigid`,
`terramechanics` and `bed` in that staggered order. Pass `wheelSoil(width, length, material)` in a vehicle's
ground material to use the same stress fit in suspension. Set `inputRows` to the number of wheels and belts.
For legged bodies, load with `{ legged: true }`, configure the foot rows and place `legged-locomotion` first.
`AirborneParticles.load({ terrain: true, dustField: soil.dustField })` reads the live layout-1 mineral flux.

The default dry material has `kc = 1,000`, `kphi = 400,000` and `n = 1` in the SI Bekker fit. It uses 500 Pa
cohesion, 0.6 internal friction, 25 mm shear length, 20% compaction, 0.05% fines from uncompacted volume and
1,600 kg/m³ dry bulk density. Replace these coefficients with a measured material for the footprint and moisture.
Each empirical coefficient may be signed. The combined pressure coefficient for the chosen footprint must be positive.
The optional `floor` is the same uniform bedrock elevation used on TerrainBed. Both solvers must share their cell.

`Terramechanics.load({ tier: 'resolved' })` distributes bearing stress within each patch and normalizes the
integrated pressure to the measured load. It uses the effective width `2 × area / perimeter`. Set
`rounded: true` for a parabolic depth profile inside rectangular or elliptical footprints. For wheel suspension,
pass `{ rounded: true }` as the fifth argument to `wheelSoil` to opt in to the same fit. The resolved tier publishes
`pressureField` in pascals on the bed vertices and reports raster visits, repose faces and moved volume through
`soil.work`. `reposeSlope` controls how far newly displaced loose soil can transfer across adjacent faces. It
defaults to the internal-friction tangent. The default `'mean'` tier uses uniform pressure and one berm ring.

For a tread, sole or hoof with disconnected contact, pass `profiles` when adding the resolved solver. Supply
one entry for each fixed patch, then each external wheel or belt row, then each configured foot. Use `null`
for the built-in shape. Each profile contains `columns` across the footprint, `rows` along its forward direction,
and normalized vertex `depth` values in across-major order. A zero-depth gap carries no pressure. Use the
projected `area` in m² and total contact `perimeter` in metres measured on that shape.
