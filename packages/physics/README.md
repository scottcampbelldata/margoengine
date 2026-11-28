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

## Rigid bodies quick start

Two solver tiers, one option: `new Physics(engine, {fidelity: 'high'})` runs 32 substeps with contacts at 480 Hz where the default `'standard'` runs 8 at 120 Hz (Macklin et al. 2019, "Small Steps in Physics Simulation"; Catto's soft step), four times the solver work, for heavy loads on light bodies, tall stacks and small parts. A soft contact rests at the allowed penetration plus W / (m (2 pi f)^2), so a 0.5 m box under a box of 1000 times its mass sinks 18 mm at the standard tier and 1.3 mm at the high one (`tests/fidelity.test.js`). Both tiers pass the same exact solutions (`tests/rigid-validation.test.js`) and the measured domino wave of Larham (2008), one friction fitted and four spacings held out within 0.1 sqrt(g H) (`tests/rigid-measured.test.js`). `physics.fidelity` reads the tier; `substeps` and `setSolver` replace what it set.

Densities by name: `density: 'steel'` (or `collider.setDensity('oak')`) takes the material's kg/m³ from `densities`, real values from the CRC Handbook, the USDA Wood Handbook and Callister (air, water, seawater, ice, human, balsa, pine, oak, cork, rubber, plastic, glass, concrete, brick, granite, sand, aluminium, steel, iron, copper, lead, gold); `densityOf(name)` reads one. The default stays 1 kg/m³, Rapier's, so values tuned for Rapier carry over.

A floor, a bouncing ball, two seconds of fixed steps, and the mass the solver computed from the ball's density (kg/m³; 1 by
default, as in Rapier, so pass a real one):

```ts
import { Physics } from '@margoengine/physics';
await Physics.load();
const physics = new Physics(null); // new Physics(engine) steps with the engine and moves the meshes you pass
physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [10, 0.5, 10] } });
const ball = physics.addBody(null, { position: [0, 5, 0], colliders: { shape: 'sphere', radius: 0.5, density: 1000, restitution: 0.6 } });
for (let i = 0; i < 120; i++) physics.step();
console.log(ball.position, ball.mass); // mass 523.6 kg = 1000 x 4/3 pi 0.5^3
```

A live page with all of it at once (instanced bodies on heightfield terrain, a pointer ray, an explosion, every shape with
its computed mass): `examples/physics-rigid.html`.

Bounces follow Newton's law of restitution. A strike into balls that touch is passed on one pair at a time, at its time of
impact, and a body held by joints is struck with its joints holding it, so a Newton's cradle of balls hung on `revolute`
joints swings one in, one out at either tier. Give its balls friction 0: a hung ball turns with its swing, and rigid
Coulomb friction at the strike keeps only `1 - mu r / l` of the speed at each pair (`docs/limits.md`, "Touching
Newton's cradle").

Examples that drive other physics libraries by hand map onto Margo in [docs/physics-migration.md](../../docs/physics-migration.md).

## Character controller quick start

A kinematic capsule that walks, climbs slopes up to 45 degrees and slides off steeper ones, steps up 0.3 m ledges, snaps
down stairs, rides what it stands on, pushes crates and jumps. `walk(velocity)` takes a speed in m/s and adds the world's
gravity and the jump itself, once per fixed step:

```ts
import { Physics } from '@margoengine/physics';
await Physics.load();
const physics = new Physics(null);
physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [20, 0.5, 20] } });
const body = physics.addBody(null, { type: 'kinematicPosition', position: [0, 0.9, 0], colliders: { shape: 'capsule', halfHeight: 0.5, radius: 0.3 } });
const controller = physics.createCharacterController(body, { applyImpulsesToDynamicBodies: true, characterMass: 70 });
physics.on('beforestep', () => controller.walk([1.5, 0, 0]));
for (let i = 0; i < 120; i++) physics.step();
console.log(controller.grounded, controller.jump(5), body.position);
```

- `walk(velocity, filter?)` moves at `velocity` (m/s; its part along `up` is ignored) for one `fixedTimestep`, falling
  under the world's gravity from where it leaves the ground: the height along `up` changes by v dt - g dt^2 / 2 and the
  speed by -g dt each step, so a jump at v rises v^2 / 2g whatever the step. Landing, or a ceiling met while rising, sets
  the speed along `up` to 0. It is `move` with that translation, so every option below applies.
- `jump(speed)` leaves the ground at `speed` m/s on the next `walk`, and returns false (doing nothing) in the air.
  `verticalSpeed` reads the speed along `up`.
- `move(desired)` is Rapier's `computeColliderMovement`: a translation for this step, gravity included by you.
- Ground and support: `grounded`, `platform` (the body stood on), `groundNormal`, `slopeAngle` (radians, 0 in the air),
  `platformVelocity` (m/s inherited from it) and `isSlidingDownSlope`.
- `takeState()` and `restoreState(state)` hold what the controller carries between steps (grounded, sliding, the speed
  along `up`, the last movement) as six numbers, so a `physics.takeSnapshot()` restore with them replays bit for bit.
- `debugRender(options?)` gives its debug lines for `@margoengine/physics/debug-view`: the collider tinted green on the
  ground, orange sliding, blue in the air; the ground normal and slope arc; the last step probe; the platform's velocity;
  the contacts of the last move.

Bad input is a `MargoError` linked to [its help entry](https://margoengine.com/errors#characters).

## Debug view (`@margoengine/physics/debug-view`)

One debug view for a world and everything on it. `await PhysicsDebugView.attach(engine, physics)` draws the world's
`debugRender()` lines (colliders, joints, contacts, and any of its options) as one segment line of `@margoengine/lines`
every frame, after the step; `add(source)` draws any other source of debug lines with them: a `CharacterController`, a
`DynamicCharacter`, a `Ragdoll` or a character bridge (each has `debugRender()`), or a function returning
`{vertices, colors}`, which is how a breakable, water or a flock adds its own. The lines package loads only when the view is
attached, so neither the physics root nor core and stage gain a byte.

```ts
import { EngineKernel } from 'margoengine/core';
import { Physics } from 'margoengine/physics';
import { PhysicsDebugView } from 'margoengine/physics/debug-view';
await Physics.load();
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!);
const physics = new Physics(engine);
physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [10, 0.1, 10] } });
const player = physics.addBody(null, { type: 'kinematicPosition', position: [0, 1, 0], colliders: { shape: 'capsule', halfHeight: 0.5, radius: 0.3 } });
const controller = physics.createCharacterController(player);
const view = await PhysicsDebugView.attach(engine, physics, { world: { boxes: true }, centerOfMass: true });
const stop = view.add(controller); // the capsule, ground normal, step probe and contacts of its last move
engine.start();
```

| Option (default) | Meaning |
| --- | --- |
| `enabled` (true) | Draw at all; also a live field. |
| `world` (`{}`) | What of the world to draw, as `physics.debugRender(options)` takes it (`colliders`, `joints`, `contacts`, `boxes`, `axes`, `solverContacts`, `pseudoNormals`, `filter`, `style`), or `false` for none; a live field. |
| `centerOfMass` (false) | A cross at each dynamic body's centre of mass; a live field. |
| `name` (`'physics-debug-view'`) | Plugin name, unique in the scene. |
| `width` (1.5) | Line width in CSS pixels. |
| `onTop` (false) | Draw over the scene without the depth test. |
| `sink` (none) | `{update(lines)}` that takes the merged lines each frame instead of `@margoengine/lines` (a WebGL2 preview, your own renderer, a test). |

`add(source)` returns a function that stops drawing it. `collect()` gives this frame's merged lines (the world's first, then
each source in the order added); `new PhysicsDebugView(physics)` without an engine gives the same lines, for a test or a
renderer of your own. Attach it after `Physics`: both are late plugins, so it updates after the step of the same frame.
`dispose()` removes its line (and the `Lines` plugin when it made one); `using` works. Bad input is a `MargoError` linked to
[its help entry](https://margoengine.com/errors#physics-debug-view).

## Boundary-layer wind (`@margoengine/physics/boundary-layer`)

`BoundaryLayerSolver` publishes accepted velocity, density and temperature on a regular local grid and
implements the continuous Wind query for rain, rigid air loads and other physics consumers.

```ts
import { BoundaryLayerSolver } from '@margoengine/physics/boundary-layer';
import { PhysicsWorld } from '@margoengine/physics/world';
import { BoundaryLayerWind } from '@margoengine/weather/boundary-layer';

const profile = new BoundaryLayerWind({ speed: 12, roughness: 0.03, obukhovLength: 90, turbulence: false });
using wind = await BoundaryLayerSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(wind, {
  profile: profile.profile,
  grid: { cells: [3, 3, 1], origin: [0, 0, 0], spacing: [5, 10, 5] },
});
world.advance(60);
console.log(wind.sample(0, 20, 0, wind.elapsedSeconds).velocity[0] > 12); // true
```

`grid.origin` is the first sampled position in the declared cell. `grid.spacing` is in metres. The
`sampleField` publishes layout-1 f64 rows of velocity X, Y, Z, density and temperature, with X varying
fastest, then Y and Z. The solver accepts `load({ id, threads, signal })` with default ID
`'boundary-layer'` and one thread. Use `worldMemory(true)` with multiple threads. In a browser,
run that world in a Worker on a cross-origin-isolated page. `workCounts()` reports the last accepted
tick's sample, SIMD and turbulence counts. Querying `sample` at any finite signed time does not
advance the grid.

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
using sediment = await SedimentTransport.load();
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
per-cell pressure from vegetation. `bankErodibility` scales signed bank-parallel velocity relative to the
mean of the connected local cross-section. Both sides of the bank exchange use the same transported mass.
`budget` reports bed and suspended masses and boundary exports in kg.

`SedimentTransport.load({ threads, signal })` optionally starts native workers or aborts the load.
The default is one native thread. Use `worldMemory(true)` for multiple threads, and host the world in a
Worker on a cross-origin-isolated browser page. `workCounts()` reports accepted cell and face proposals for
each partition. Dispose the solver after removing it from the world. `ShallowWaterSurface` accepts this
solver as its `sediment` source to tint the same live water that moves the bed.

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
For a grid port, put the sender in the same world cell and match the cell dimensions and order. A single
value is spatially uniform. Sample a time-varying rain source at the physics clock to author a storm.
An ATMO-09 water-flux port supplies snowmelt and evaporation. All published regions are layout-1
f64 grids. Depth and soil water use metres, infiltration and recharge use m/s, and channel and outlet
discharge use m³/s. The runoff budget measures every external gain and loss in m³. Match the area
upstream of a mapped outlet to the flood grid it feeds so direct flood rain and routed basin rain are each counted once.

For larger catchments, choose `RainfallRunoff.load({ threads: 4 })` and use
`new PhysicsWorld({ memory: worldMemory(true), rate: { num: 60, den: 1 } })`. Import `worldMemory` from `@margoengine/physics/world`.
Choose any whole thread count from 1 to 64. The default is one. Run the shared path in Node
or a cross-origin-isolated browser worker. `workCounts()` returns the last accepted tick's
native soil, rainfall and graph visits. Dispose the removed solver with `[Symbol.dispose]()`
or a `using` declaration.

To show the accepted water from the output above, give `flood` to `ShallowWaterSurface.attach`
from `@margoengine/water/shallow-surface` with a Water surface configured for the same bed.
Advance or seek the world before drawing. A refused runoff step keeps the previous accepted water and ledger.

## Rooted plants in wind and water

`@margoengine/physics/vegetation` models each plant as a tapered cantilever with two bending modes on each horizontal axis. Set its geometry, tissue density and Young’s modulus in SI units. A `FlowField` supplies the velocity and density of air or water at the plant and at the world clock's time.

```ts
import { PlantSway } from '@margoengine/physics/vegetation';
import { PhysicsWorld } from '@margoengine/physics/world';
import { BoundaryLayerWind } from '@margoengine/weather/boundary-layer';

const breeze = new BoundaryLayerWind({ speed: 6, roughness: 0.03, turbulence: false });
using sway = await PlantSway.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(sway, {
  flow: breeze,
  plants: [{ root: [0, 0, 0], height: 1.5, baseDiameter: 0.035,
    tipDiameter: 0.012, youngModulus: 8e8, density: 650, dampingRatio: 0.04 }],
});
world.advance(60);
const tip = sway.sample(0, 1.5);
console.log(tip.displacement, sway.dryFrequencies(0), sway.workCounts());
```

Each root is a position in `sway.cell`, and the stem starts along +Y. `cellSize` defaults to 4096 m.
Pass your world's cell size when a flow field and the plants use different origins. A plant without a crown is all stem.
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
a snapshot whenever needed, including at frame zero. The rigid solver and plant use the same origin.

```ts
import { Physics, type ColliderOptions } from '@margoengine/physics';
import { PlantRigidSolver, PlantSway } from '@margoengine/physics/vegetation';
import { PhysicsWorld } from '@margoengine/physics/world';

await Physics.load();
const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] });
using sway = await PlantSway.load();
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

`PlantSway.load({ threads: 4 })` integrates the same modal system in four native partitions in a shared world.
Use an isolated world Worker for browser threading. The default is one. Read `workCounts()` for the last accepted
tick's standing plants, midpoint substeps and SIMD mode work. Positions and fields use the host's signed cell.
A rejected native calculation keeps the last accepted poses. Dispose the sway solver when finished.

## A car in nine lines

`Vehicle.car(physics, chassis)` lays four wheels out from the chassis's box and tunes them so the car rests, drives, steers and brakes at once: no suspension, grip or engine numbers to find first.

```ts
import {Physics, Vehicle} from '@margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [100, 0.5, 100]}});
const chassis = physics.addBody(null, {position: [0, 1, 0], colliders: {shape: 'box', halfExtents: [0.9, 0.3, 2], mass: 1200}});
const car = Vehicle.car(physics, chassis);
physics.on('beforestep', () => car.setInput({throttle: 1, steer: 0.2}));
for (let i = 0; i < 120; i++) physics.step();
console.log(car.speed.toFixed(1), 'm/s');
```

On a page, give the chassis a mesh and the four wheels meshes of their own (children of the chassis mesh, axle along x), drive it from the keyboard, and draw `car.debugRender()` with `@margoengine/lines`: each suspension ray (blue, mount to hub; grey, hub to ground), each contact point and its normal (magenta), each tyre's push as a share of its load (green while it grips, red as it slides) and each wheel's rim.

```ts
import {Engine, box} from 'margoengine/core';
import {Line, LineMaterial, Lines} from 'margoengine/lines';
import {Physics, Vehicle} from 'margoengine/physics';

await Physics.load();
const engine = await Engine.create(document.querySelector('canvas')!);
const physics = new Physics(engine);
const floor = engine.createMesh().setGeometry(box(200, 1, 200)).setPosition([0, -0.5, 0]);
physics.addBody(floor, {type: 'fixed', colliders: {shape: 'box', halfExtents: [100, 0.5, 100]}});
const body = engine.createMesh().setGeometry(box(1.8, 0.6, 4)).setPosition([0, 1, 0]);
const chassis = physics.addBody(body, {colliders: {shape: 'box', halfExtents: [0.9, 0.3, 2], mass: 1200}});
const wheelMeshes = [0, 1, 2, 3].map(() => engine.createMesh().setGeometry(box(0.19, 0.63, 0.63)).setParent(body));
const car = Vehicle.car(physics, chassis, {wheelMeshes});

const keys = new Set<string>();
addEventListener('keydown', (event) => keys.add(event.code));
addEventListener('keyup', (event) => keys.delete(event.code));
const axis = (plus: string, minus: string) => (keys.has(plus) ? 1 : 0) - (keys.has(minus) ? 1 : 0);
physics.on('beforestep', () =>
  car.setInput({throttle: axis('KeyW', 'KeyS'), steer: axis('KeyA', 'KeyD'), brake: keys.has('Space') ? 1 : 0}),
);

const material = new LineMaterial({width: 2, onTop: true}); // drawn over the car, so the rays inside it show
const debug = Lines.attach(engine).add(new Line({mode: 'segments', positions: [0, 0, 0, 0, 0, 0], material}));
physics.on('afterstep', () => {
  const {vertices, colors} = car.debugRender();
  debug.setPositions(vertices, colors);
});
engine.start();
```

The arcade layout, from the body's half sizes along its forward, left and up axes (`L`, `W`, `H`): wheel radius `r = 0.35 min(W, L)`, suspension rest length `0.85 r`, wheel centres on the body's sides (`W` either side, half of each tyre outside the body) and `0.7 L` ahead and behind the body's centre, the front pair steering and all four driving and braking. The springs rest a third of the way in (`suspensionStiffness = g / (4 sag)` per kilogram of chassis with `sag = rest / 3`), damped at 0.3 of critical on compression and 0.5 on extension (each damper reads how fast its spring's length changed over the step, so a still car's springs rest at the sag whatever `physics.substeps` is), each carrying up to six times its share of the weight, and each hub rests `0.2 r` above the bottom of the body, so the body rides about `0.8 r` off the ground. Grip, engine force (the chassis mass in newtons a wheel, 0.4 g in all), brakes (1.2 g) and steering (0.5 rad at full lock) keep the `Vehicle` defaults. Every option of `new Vehicle` but `wheels` passes through (`maxEngineForce`, `tyre`, `drivetrain`, `antiRollBars`, `forward` and the rest), `wheel` overrides any wheel setting for all four (`{radius: 0.4, frictionSlip: 2}`), `halfExtents` gives the size of a chassis without a box collider, and `wheelMeshes` are drawn front left, front right, rear left, rear right. `car.debugRender({suspension, contacts, slip, wheels, style})` switches each part off and recolours it; it reads the last step and changes nothing. A snapshot of a world with a vehicle is `physics.takeSnapshot()` plus `car.writeMotionState(buffer)` (controls and wheel spin), restored with `restoreSnapshot` and `readMotionState`, and replays bit for bit. A vehicle, `Vehicle.car`, tyre model, drivetrain or motorcycle given input it cannot use throws a `MargoError` (code `unsupported`, or `state` for a chassis of another world, `disposed` after `dispose()`) whose message names the input and the fix and links [margoengine.com/errors#vehicles](https://margoengine.com/errors#vehicles).

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

## Elastic rods

`@margoengine/physics/rod` makes cables, mooring lines, hoses, tentacles, hair and grass blades that bend, twist and
stretch: `new Rod(physics, {points, radius, youngModulus})`. A rod is a chain of capsule links held to reduced coordinates
as one multibody. Its elasticity is springs on the joints between links, solved inside the tree's direct solve by backward
Euler, so a stiff rod of hundreds of links is stable at any step:
- bending EI / l about the link's two cross axes and twisting GJ / l about it, each link the Cosserat rod's energy over its
  length (Kugelstadt and Schömer 2016; Deul et al. 2018);
- stretching EA / l along it.

The material sets them from `youngModulus` and `shearModulus` with a round section. `bendStiffness`, `twistStiffness` and
`axialStiffness` override them; `axialStiffness: Infinity` makes the rod inextensible. A braided rope bends and twists far
more easily than a solid rod of its fibre, so give a rope its own small `bendStiffness`.

Rest shape and ends:
- The centre line you pass is the rest shape, so a curled `points` line gives a tentacle its curl.
- `attachStart` and `attachEnd` pin an end to a body or to a fixed point (`'fixed'`).
- `clamp` makes an end hold its direction too.
- `rod.release('end')` casts an end off, as a line is let go from a hull.

Pins are held in the tree's solve with the rod's springs. A cable pulled taut between two pins stays closed at both, and
each pinned end stretches by its half link.

`loads` puts the rod in water: `segmentLoads(sea)` from `@margoengine/physics/loads`, where `sea` is a `SpectralSea` or
anything with `water.sample`, `elevation` and `density`. Below the surface each link then feels:
- its buoyancy, on the wetted part of its length;
- Morison's drag across it (DNV's coefficients by roughness and Keulegan-Carpenter number, and below the drag crisis the
  drag of its Reynolds number) and Eames's drag along it, on the water's velocity relative to the link. Both are taken
  into the tree's solve as a damping toward the flow, so a light link in a hard flow stays stable;
- the water's own acceleration with DNV's added mass;
- across a flow, the lift of its shed vortices from a wake oscillator driven by the link's own motion (Facchinetti, de
  Langre and Biolley 2004), so a taut cable strums at its own frequency through lock-in.

Any other provider of `SegmentLoads` can push the links instead.

Contact goes through the rigid solver: fish, divers and hulls push the links aside. `rod.points()` and `rod.frames()`
read the centre line and each link's turn for drawing. `rod.takeState()` and `rod.restoreState()` keep the wake
oscillators beside `physics.takeSnapshot()`. In a `PhysicsWorld`, a rod is stepped by `RigidSolver` with the Physics it
hangs in: the solver keeps every stateful attachment's words (`physics.statefulAttachments()`) with the kernel's, so a
world's snapshot, restore and hash carry the wake oscillators, and the shot is the same at any frame rate. Make the rods
before adding the Physics to the world.

```ts
import {Physics} from 'margoengine/physics';
import {Rod} from 'margoengine/physics/rod';
import {SpectralSea} from 'margoengine/physics/sea';
import {segmentLoads} from 'margoengine/physics/loads';

await Physics.load();
const physics = new Physics(null);
// One wave of 1 m amplitude with a 10 s period over deep water.
const frequencies = Float64Array.from({length: 34}, (_, i) => 0.04 * 25 ** (i / 33));
const directions = Float64Array.from({length: 24}, (_, j) => (2 * Math.PI * j) / 24);
const energy = new Float64Array(34 * 24);
const bin = frequencies.findIndex((f) => f >= 0.1);
energy[bin * 24] = 1 / 2 / (((frequencies[bin + 1] - frequencies[bin - 1]) / 2) * ((2 * Math.PI) / 24));
const sea = new SpectralSea({waves: {frequencies, directions, energy, depth: Infinity, density: 1025}});

// An anemone's tentacle: 30 cm, curled, soft as rubber, clamped to the rock 5 m down.
const points = Array.from({length: 9}, (_, k) => [0.05 * Math.sin(k / 3), -5 + 0.0375 * k, 0] as [number, number, number]);
const tentacle = new Rod(physics, {points, radius: 0.004, density: 1050, youngModulus: 2e5, attachStart: 'fixed', clamp: 'start', loads: segmentLoads(sea, {period: 10})});

// A diver's hose: 10 m, pinned to a fixed point at the surface and to the diver's tank (here a fixed point too).
const hose = new Rod(physics, {start: [2, -0.2, 0], end: [8, -6, 0], segments: 40, radius: 0.012, density: 1100,
  youngModulus: 5e7, attachStart: 'fixed', attachEnd: 'fixed', loads: segmentLoads(sea, {period: 10})});

for (let i = 0; i < 120; i++) physics.step();
console.log(tentacle.points().length, hose.held('end')); // 75 true
hose.release('end'); // the hose is let go at the tank
```

For direction, a rod blends toward a shape you give it: `rod.setTarget(points, {frequency, damping})` pulls each link toward
its place on `points` as a spring on its own mass (default 1 Hz, critically damped), with its bending, loads and contacts
acting too, and `rod.setTarget(null)` lets go. `segmentAirLoads(wind)` loads a rod in the air (rigging, a kite line, a vine)
with a wind field's drag and its vortices, which make a taut wire sing. `swayFlow({speed, period, seed})` is a seeded sway,
three travelling gusts about no mean, to add to any loads' `flows`, so a kelp bed or a field of grass moves gently and the
same seed moves it the same way every run.

```ts
import {Physics} from 'margoengine/physics';
import {Rod} from 'margoengine/physics/rod';
import {segmentAirLoads, swayFlow} from 'margoengine/physics/loads';

await Physics.load();
const physics = new Physics(null);
const breeze = {
  medium: 'air' as const,
  cell: [0, 0, 0] as const,
  sample(_x: number, _y: number, _z: number, _t: number, out = {velocity: [0, 0, 0] as [number, number, number], density: 1.225, temperature: 288}) {
    out.velocity[0] = 6;
    out.velocity[1] = out.velocity[2] = 0;
    return out;
  },
};
// A pennant line on a mast in a 6 m/s breeze that gusts, seeded.
const line = new Rod(physics, {start: [0, 5, 0], end: [0, 3, 0], segments: 16, radius: 0.003, density: 1150,
  attachStart: 'fixed', loads: segmentAirLoads(breeze, {flows: [swayFlow({speed: 1.5, period: 4, seed: 11, medium: 'air'})]})});
// A tentacle reaching for a mark, then let go.
const tentacle = new Rod(physics, {start: [2, 0, 0], end: [2, 0.4, 0], segments: 12, radius: 0.01, attachStart: 'fixed'});
tentacle.setTarget([[2, 0, 0], [2.2, 0.3, 0], [2.4, 0.3, 0]], {frequency: 1.5});
for (let i = 0; i < 120; i++) physics.step();
tentacle.setTarget(null);
console.log(line.points().length, tentacle.valid); // 51 true
```

A rope over bollards, pulleys and fairleads is `WrappedRope` (`@margoengine/physics/wrapped-rope`): its mass in nodes, and between two nodes a straight span or
a wrap over a fixed cylinder that the rope's material slides through (after Sueda, Jones, Levin and Pai's strands, 2011).
Each wrap holds by static friction while the tensions either side are within the capstan ratio `e^(mu phi)`, `phi` its
angle, and slides with the high side at that ratio times the low one, so a load over a bollard is held by a fraction of
its weight, and a winch draws a line in over it. A fixed node is a cleat or a winch (`setNodePosition`); `tension(i)`,
`holding(i)`, `position(i)` and `velocity(i)` read it. It is a solver of its own, stepped with `step(dt)`.

```ts
import {WrappedRope} from 'margoengine/physics/wrapped-rope';

// A 50 kg load on a line over a bollard of 0.2 m, made fast to a cleat: friction 0.3, half a turn.
const line = new WrappedRope({
  nodes: [{position: [-0.2, -1, 0], fixed: true}, {position: [0.2, -1, 0], mass: 50}],
  wraps: [{center: [0, 0, 0], axis: [0, 0, 1], radius: 0.2, friction: 0.3, turn: -1}],
});
for (let i = 0; i < 60; i++) line.step(1 / 60);
const [cleat, load] = line.tension(0);
console.log(Math.round(load), Math.round(cleat)); // 491 191: the bollard takes the rest
```

On bodies that move, `WrappedRopeSolver` is the same rope as a solver of the physics framework, coupled both ways to the
rigid world: a node is a free mass or a point on a body (`{body: row, point}`, a boat's fairlead), and a wrap's cylinder may
ride on a body (`body`, with its centre and axis in the body's frame): a winch's drum, a bollard on a ship. Each side's
stretch is measured against the drum's surface where the rope leaves it, so a turning drum winds the rope in or slips
under it, and each pull on a node is matched on the drum at that point, so the rope hands the bodies its tension
(`bodyForces`) with momentum and angular momentum kept. Couple it before the rigid solver. `tension(i)`, `holding(i)` and
`read(k)` (a free node's position and velocity) read it.

```ts
import {Physics} from '@margoengine/physics';
import {WrappedRopeSolver} from '@margoengine/physics/wrapped-rope';
import {PhysicsWorld, RigidSolver} from '@margoengine/physics/world';

await Physics.load();
const physics = new Physics(null, {gravity: [0, -9.81, 0]});
// A winch drum of 0.2 m turning on a deck, a 2 kg and a 1 kg load on a line over its top.
const drum = physics.addBody(null, {type: 'kinematicVelocity', angularVelocity: [0, 0, -25], colliders: []});
const line = new WrappedRopeSolver();
const world = new PhysicsWorld({rate: {num: 60, den: 1}, gravity: [0, -9.81, 0]})
  .add(new RigidSolver(), {physics})
  .add(line, {
    nodes: [{position: [-0.2, -1, 0], mass: 2}, {position: [0.2, -1, 0], mass: 1}],
    wraps: [{body: drum.row, center: [0, 0, 0], axis: [0, 0, 1], radius: 0.2, friction: 0.3, turn: -1}],
  })
  .couple(['wrappedRope', 'rigid'], 'staggered');
world.advance(60);
const [lifting, paying] = line.tension(0);
console.log((lifting / paying).toFixed(3), line.holding(0)); // 2.566 false: the drum slips under the line at e^(0.3 pi)
```

A mooring line or anchor chain on the seabed is `MooringLine` (`@margoengine/physics/mooring`): lumped masses on segments that take tension only (it goes
slack rather than push), its internal damping while taut, Morison's loads on each segment's own normal and tangent
(buoyancy of its wetted length, drag across and along, added mass across, `drag` and `addedMass` on `diameter` and its
material's volume), and a seabed (`seabed: {y, friction, lateralFriction}`) with Coulomb friction along and across the line
on what rests there. `clumps` add weights or buoys at nodes; `breakingLoad` parts a segment past it for good (`broken`);
snap loads come of themselves when a slack line is pulled taut. Hold its ends with `setEnd` (a fairlead that moves), step it
with `step(dt)` (it takes the substeps its springs need), and read `tension(i)`, `endForce(end)` (the load on what holds
that end), `position(i)` and `velocity(i)`. Checked against the measured top tensions of a 33 m chain driven round circles
(Bergdahl et al. 2016, 30 cases, mean error 2.7 %) and the elastic catenary with its grounded length.

```ts
import {MooringLine} from '@margoengine/physics/mooring';

// 100 m of 10 kg/m chain from an anchor on the seabed to a fairlead 90 m off and 20 m up, in still sea water.
const sea = {density: 1025, elevation: () => 30, water: {medium: 'water' as const, cell: [0, 0, 0] as const,
  sample: (x: number, y: number, z: number, t: number, out = {velocity: [0, 0, 0] as [number, number, number], density: 0, temperature: 0}) =>
    Object.assign(out, {velocity: [0, 0, 0], density: 1025, temperature: 288})}};
const chain = new MooringLine({
  start: [0, 0, 0], end: [90, 20, 0], length: 100, massPerLength: 10, axialStiffness: 1e7, segments: 40,
  water: sea, seabed: {friction: 0.7}, drag: {normal: 2.4, tangential: 1.15},
});
for (let i = 0; i < 1800; i++) chain.step(1 / 60);
const [fx] = chain.endForce('end');
console.log(chain.tension(0), -fx > 0); // 0 true: the seabed's friction holds the grounded chain, the fairlead pulls
```

## Loose props on a moving deck

Props resting on a moving body (cups, plates and chairs in a ship's saloon, crates in a lift) stick, slide and tip as its
accelerations ask, through ordinary contacts with friction. A deck driven by forces (a hull the sea solvers move) needs
nothing more.
- A deck driven to its pose each step (`kinematicPosition`) should also get the velocity and spin to reach each pose with,
  `setNextVelocity`, as the motion's own derivative. It then moves on a smooth path through the step. Driven at one speed
  a step, its whole change of speed lands in a step's first substep, where a prop's friction holds only mu N h, and props
  slip.
- Keep the deck within a few hundred metres of the origin: f32 poses far out round each move the same way, and a deck 1 km
  out at 17 m/s loses its props 0.4 m a minute (`docs/known-bugs.md`, KB-PHYS-POSEROUND1).
- Up to 16 substeps a prop holds where friction holds it; from 32 it still slips slowly (`docs/known-bugs.md`,
  KB-PHYS-FINECONE1).
- A prop may touch through several colliders (a chair on four legs): the pairs between two bodies whose normals agree
  solve their friction as one patch, so it holds where one box would, within 2 mm on the storm deck of
  `tests/deck-props.test.js` (KB-PHYS-MULTIPAIRCREEP1, fixed 2026-11-28).

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
const roll = (t: number) => 0.3 * Math.sin((2 * Math.PI * t) / 10); // 17 degrees at 10 s
const deck = physics.addBody(null, {type: 'kinematicPosition', colliders: {shape: 'box', halfExtents: [6, 0.25, 4]}});
const cup = physics.addBody(null, {position: [0, 0.35, 0], colliders: {shape: 'box', halfExtents: [0.04, 0.1, 0.04], friction: 0.6}});
for (let i = 1; i <= 600; i++) {
  const t = i / 60, a = roll(t), spin = 0.3 * ((2 * Math.PI) / 10) * Math.cos((2 * Math.PI * t) / 10);
  deck.setNextRotation([Math.sin(a / 2), 0, 0, Math.cos(a / 2)]);
  deck.setNextVelocity([0, 0, 0], [spin, 0, 0]);
  physics.step();
}
console.log(cup.position[1] > 0); // true: still on the deck after ten seconds of rolling
```

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

`explosion(physics, center, {impulse, radius, falloff = 'linear', lift = 0, filter})` gives every dynamic body within `radius` an impulse away from `center` at its centre of mass, scaled by the falloff (`'linear'` to nothing at the radius, `'inverse-square'` or `'none'`), with `lift` adding an upward share; it returns the bodies it pushed. `new WindForce(physics, {velocity, density, drag = 1.17, friction = 0.004, region, filter})` loads every dynamic body in `region` each step from its shape (AERO-01): each collider's surface is cut into panels (boxes, spheres, capsules, cylinders, cones, convex hulls and triangle meshes as themselves; other shapes as the box of their bounds), and each panel the air meets takes the flat-plate normal force `drag` sin(a) times the dynamic pressure 1/2 rho |w|^2 times its area, a the angle at which the air w (relative to the moving panel, so a spinning body feels its spin) meets it, plus skin friction `friction` along the surface. Summed about the centre of mass they give drag, the lift of an inclined surface and the moment of uneven loads (a gust that hits the top of a box harder tips it). `velocity` is a vector, a function of the point and the time (gusts, swirls), or a shared flow field of `@margoengine/math/fields` (a `Wind`, such as the atmosphere solver's), sampled at each panel at the world's time (`stepCount * fixedTimestep`, or a `PhysicsWorld`'s tick when an `AirSolver` steps it: the clock the rest of a scene shares) and in the field's local frame. The rigid and wind origins default to `[0, 0, 0]`. `density` defaults to the flow field's at each body, or else the standard atmosphere's at the body's height (`standardDensity(y)` of `@margoengine/math/atmosphere`, y metres above sea level: 1.225 kg/m3 at 0, 0.736 at 5 km). The load is held on each body as a force through that step only and taken off exactly after it (in a world, through `bodyForces`), so a body the wind holds up keeps its height and keeps its own `addForce` to the bit when the wind stops, and it is taken implicitly in the body's motion (the drag of the speed the step ends with), so a sheet of paper in a gale follows the wind without overshooting it at 60 steps a second. A heavy body is slower to follow than a light one, a sleeping body is woken only by a wind that would push it a tenth of a metre a second squared, and `remove()` stops it. It was called `WindField` until 2026-11-25; that name still works and is deprecated, since `WindField` is the wind itself in `@margoengine/weather`.

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

### Native wind traction (AERO-01)

The scalar constructor stays synchronous. `WindForce.create(physics, options, {threads, signal})` loads the optional native
traction evaluator. Choose 1 (the default), 2 or 4 participants. The caller counts as one. Workers split the implicit
force-and-torque probes, which reduce in panel order. `workCounts()` gives cumulative probe, panel and SIMD pair counts
for each participant. `remove()` and `using` release the load and its workers. An optional `AbortSignal` cancels loading.

When reading a floating-origin `Wind`, give `frame` the rigid solver's current signed cell and cell size. In a
`PhysicsWorld` use `{cellSize: world.cellSize, get cell() { return world.cellOf('rigid'); }}`. Each sample is converted
from body-local world metres into the wind cell before calling the field. Positions for a standalone vector or callback
stay in the rigid frame. Pass `density` when it is prescribed, or supply it with each wind sample.

```ts
import {Physics, WindForce} from '@margoengine/physics';

await Physics.load();
using physics = new Physics(null);
physics.gravity = [0, 0, 0];
const panel = physics.addBody(null, {
  colliders: {shape: 'box', halfExtents: [0.01, 0.4, 0.6], mass: 1},
});
using wind = await WindForce.create(physics, {velocity: [4, 0, 0], density: 1.2}, {threads: 2});
physics.step();
console.log(panel.linearVelocity[0] > 0, wind.workCounts()?.probes); // true 13
```

### Gravity fields, updrafts and vortices

Radial and cylindrical force fields, as attachments that push every step until removed. Each takes `center`, `radius`,
`falloff` (`'linear'` by default, `'inverse-square'` or `'none'`, from the centre or the axis out to the radius) and a
query `filter`, holds no state of its own (a snapshot and restore replays it bit for bit), and has `enabled` (default
true) and `remove()` (`using` calls it). A body is pushed at its centre of mass, so it is thrown, not spun, and wakes.

| Field | Pushes | Its own options (default) |
| --- | --- | --- |
| `new GravityField(physics, options)` | every dynamic body within `radius` of `center` toward it, at `acceleration` m/s² whatever its mass | `acceleration` |
| `new Updraft(physics, options)` | every dynamic body in the upright cylinder of `radius` and `height` on `center` up with `strength` newtons | `height`, `strength`, `mode` (`'perpendicular'`: straight up; `'center'`: away from the centre of the base) |
| `new Vortex(physics, options)` | every dynamic body in that cylinder around the axis with `strength` newtons, counter-clockwise seen from above | `height`, `strength`, `centripetal` (0.3, the pull to the axis as a share of `strength`), `lift` (0.1, the push up) |

```ts
import {GravityField, Physics, Updraft, Vortex} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, {type: 'fixed', position: [0, -0.5, 0], colliders: {shape: 'box', halfExtents: [20, 0.5, 20]}});
const crate = physics.addBody(null, {position: [0.5, 0.3, 0], colliders: {shape: 'box', halfExtents: [0.3, 0.3, 0.3], mass: 2}});
const lift = new Updraft(physics, {center: [0, 0, 0], radius: 2, height: 6, strength: 40});
new Vortex(physics, {center: [0, 0, 0], radius: 3, height: 6, strength: 15});
new GravityField(physics, {center: [0, 8, 0], radius: 5, acceleration: 4, falloff: 'inverse-square'});
for (let i = 0; i < 120; i++) physics.step();
lift.enabled = false;
console.log(crate.position);
```

## Instanced bodies: thousands of bodies in one draw

`new InstancedBodies(physics, mesh, options)` gives every instance of an instanced mesh (`createInstancedMesh` of `@margoengine/materials`) a body of its own, `bodies[i]` (or `body(i)`) moving instance `i`. Each body starts at its instance's matrix (position and rotation; the instance's scale stays in the drawing and is never given to the collider), and after every `sync` the bodies' poses, interpolated as a mesh body's are, go to the instance matrices in one `setMatrices` write, which is skipped once every body sleeps, so thousands of bodies stay one draw call. `options` are those of `addBody` without the pose: `colliders` (required: an instanced mesh has no geometry the physics reads), `type`, damping, CCD and the rest, plus `count` (default the mesh's `instances.count`). Instance matrices are world poses, so keep `mesh.root` at the identity. `remove()` (or `using`) removes the bodies and stops the writes; the bodies are ordinary bodies of the world, so queries, events, snapshots and fields see them as any other.

```ts
import {Physics, InstancedBodies} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
// Any object with instances {data, capacity, count, setMatrices} works; createInstancedMesh(engine, geometry, material, 1000) gives one.
const data = new Float32Array(1000 * 24);
for (let i = 0; i < 1000; i++) data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i % 10, 1 + Math.floor(i / 100), Math.floor(i / 10) % 10, 1], i * 24);
const mesh = {instances: {data, capacity: 1000, count: 1000, setMatrices: (start: number, m: ArrayLike<number>) => { for (let i = 0; i < m.length / 16; i++) data.set(Array.from(m).slice(i * 16, i * 16 + 16), (start + i) * 24); }}};
const crates = new InstancedBodies(physics, mesh, {colliders: {shape: 'box', halfExtents: [0.4, 0.4, 0.4]}});
for (let i = 0; i < 30; i++) physics.step();
physics.sync(1);
console.log(crates.body(42).position, data.subarray(42 * 24 + 12, 42 * 24 + 15));
```

## Universal joint and wheel joint

`addUniversalJoint(physics, bodyA, bodyB, {anchorA, anchorB, frameA, frameB, limitsX, limitsY, motorX, motorY})` joins two bodies at a point so that they turn about the X and Y axes of frame A and cannot twist about Z (a cardan joint): a generic joint with the sliding axes and the twist locked, so `joint.setAxisLimits` and `joint.setAxisMotor` change the limits and drives later. `addWheelJoint(physics, chassis, wheel, {anchor, wheelAnchor, frequency = 4, damping = 0.7, travel, maxTorque, steerable})` hangs a wheel from a chassis on a suspension along Y of the chassis frame (a spring of that natural frequency per kilogram between the travel limits) with the axle along X, and returns `{joint, knuckle, drive(speed), coast(), steer(angle)}`: `drive` spins the wheel toward a speed under the torque cap, and a `steerable` wheel hangs from a knuckle body that `steer` turns about the suspension axis. Swing-twist is the `cone` joint and a D6 is the `generic` joint; both exist already.

## Gear, rack and pinion, pulley, distance range

`new GearJoint(physics, bodyA, bodyB, {axisA, axisB, ratio})` keeps the angle of the first body about its axis plus `ratio` times the angle of the second constant (the two turn against each other at the ratio); `new RackAndPinionJoint(physics, pinion, rack, {pinionAxis, rackAxis, radius})` moves the rack `radius` metres a radian; `new PathJoint(physics, base, follower, {points, closed, anchor, motor: {speed, maxForce}})` holds a point of the follower on a Catmull-Rom spline through any number of points (2 or more, up to a million) fixed to the base, open or `closed` into a ring (3 or more points), found by a search that starts where the follower was and skips spans by their boxes (4 spans of a thousand sampled a search on a 1,000-point loop), free to slide along it, with an optional motor along the curve (`setMotor(speed, maxForce)`): a bead on a wire, a car on a rail; the follower keeps its own orientation. `new DistanceJoint(physics, bodyA, bodyB, {anchorA, anchorB, min, max, frequency, damping})` keeps two anchors between a least and a greatest distance and leaves them free in between (a rope has only a `max`, a strut only a `min`; with a `frequency` the ends give a little and pull back); `new PulleyJoint(physics, bodyA, bodyB, {groundA, groundB, anchorA, anchorB, ratio})` keeps the rope length on one side plus `ratio` times the other constant, as a rope that pulls and never pushes (an Atwood machine). Each is a row of the kernel's solve (`kernel/src/couplings.rs`), solved in every substep next to the joints and contacts with sequential impulses and a warm start (Catto, GDC 2011, for the soft form): rigid by default, or soft with `frequency` and `damping`; `correction` is the share of the position error a biased pass removes. A pulley follows an Atwood machine to one percent whatever the masses (3:1, 1.5:1 and 10:9 are in the tests), and a coupled pair is one island, so a resting gear train sleeps as one and a touch on one end wakes it all. The table of couplings grows with the world (a thousand gears in a train are in the tests). They act next to the joints that guide the bodies (hinge each gear and the pinion, slide the rack): each row is solved on what those joints' locks let it move (the Schur complement of the locks, before the joints in each pass), so a path that holds a point off its follower's centre, on a follower whose slide holds its turn, moves the follower as a pinned point would (a cam follower tracks its groove on a turning cam for fifty turns). A gear's and a rack's error is read from the poses (each body's turn about its axis since the row began, counted past one turn, and the rack's travel), so it does not drift by float rounding over long runs: a rack driven 100 turns holds the exact travel to one or two float spacings wherever it stands. `state()` reads the error and impulse, and `remove()` lets go.

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

`WingForce.profileDrag` applies to each attached panel. A stalled panel takes the full load from its separated-flow
law and leaves the attached circulation solve. One wing can carry both regimes at the same time in a varying wind.

- **`new WingForce(physics, body, {sections, forward = [0, 0, 1], up = [0, 1, 0], mirror = true, panels = [2, 4], wind, density, frame, stall = 0.26, profileDrag = 0.008, separation, flap})`**: a wing as a vortex lattice (the method of `SailForce`). `sections` run from root to tip in the body's frame, each a `leadingEdge`, a `chord` and a nose-up `twist` (radians). With `mirror` the wing is a pair, mirrored across the plane of `forward` and `up`. So lift, induced drag, the moment about the centre of mass and the downwash between panels come from the planform and the attitude: a rectangular wing of aspect ratio 6 has the lift slope of a finite wing within 4 percent. Panels the air meets beyond `stall` separate: by default a fixed wing takes the flat plate's law and loses lift, and a flapping wing (`separation: 'flapping'`) takes the quasi-steady coefficients of Su et al. (`flatWingCoefficients`), whose leading-edge vortex keeps its lift. `flap(time)` returns `{stroke, pitch}` in radians: a rotation about the forward axis at the root, tip up, and a pitch of every section. The wing's own motion is part of the air each panel meets, so a downstroke pitched nose down pushes the body forward. `wing.force` and `wing.torque` are the last step's load, and `wing.circulation` each panel's circulation.
- **`new RotorForce(physics, body, {radius, chord, pitch, speed, hub, axis = [0, 1, 0], blades = 2, hubRadius, liftSlope = 2 pi, profileDrag = 0.008, stall = 0.26, stations = 16, wind, density, frame})`**: a rotor or propeller by blade-element momentum theory. Each annulus's induced velocity balances its blades' thrust against the momentum it gives the air. Thrust acts along `axis` for a positive `speed` (rad/s, or a function of time), and the rotor's torque turns the body the other way. `chord` and `pitch` are numbers or functions of radius. `rotor.evaluate(omega, inflow, density)` gives thrust, torque and power without stepping, and `rotor.thrust`, `rotor.torque` and `rotor.power` hold the last step's.
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

The `WingForce` constructor runs the TypeScript lattice. `WingForce.load` lazily loads the same lattice with native SIMD and the same force and moment ordering.
The `threads` option accepts one (default), two or four participants including the caller.
Multiple participants require Node or a cross-origin-isolated browser worker. Pass `signal` to cancel loading and call `wing.remove()` to close its native resources.
`wing.workCounts()` reports accepted matrix, wake and elimination work after a step. It returns null before the first accepted native load.

Wing and rotor wind default to still air. Density defaults to the field density when supplied or the standard atmosphere at the local sample height.
For a cell-based `FlowField`, set `frame` with the rigid coordinate origin and cell size, such as `{cellSize: world.cellSize, get cell() { return world.cellOf('rigid'); }}`.
Use the wind field’s live cell when shifting the world. A vector or callback continues to use local positions.

```ts
import { Physics } from '@margoengine/physics';
import { WingForce } from '@margoengine/physics/flight';

await Physics.load();
const physics = new Physics(null);
const body = physics.addBody(null, { type: "kinematicVelocity" });
const wing = await WingForce.load(physics, body, {
  sections: [{ leadingEdge: [0, 0, 0], chord: 1, twist: 0.08 }, { leadingEdge: [2, 0, 0], chord: 0.7, twist: 0.05 }],
  wind: [0, 0, -12],
});
physics.step();
console.log(wing.force[1], wing.workCounts()?.matrixPairs); // N of lift and actual paired matrix evaluations
wing.remove();
physics.dispose();
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
- **Vertex block descent.** `desc.setSolver('vertex-block')` (or `body.setSolver`) on a cloth or rope solves its edges by vertex block descent (Chen et al. 2024) instead of the edge sweep and the exact thread solve: every edge is a spring (a fabric thread of its measured stiffness, any other edge the stiffness its softness gives on its two masses, a rigid edge a very stiff spring), and each pass takes one Newton step on each particle's three coordinates of the step's incremental potential, damped by each edge's damping ratio, with threads held within their measured strain after the passes. Its first guess takes gravity only as far as the particle was last accelerating along it (the paper's adaptive initialisation), so a resting cloth hangs at its exact equilibrium whatever the passes. A strip of the default cotton hangs to Irvine's elastic-cable sag within 0.1 percent at two passes or eight; a soft edge rings at its own frequency.

```js
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null);
const soft = await SoftBodies.attach(physics);
const curtain = soft.create(
  SoftBodyDesc.cloth([0, 2, 0], [0.1, 0, 0], [0, 0, 0.1], 10, 10).setPinnedParticles([0, 9]).setSolver('vertex-block'),
);
for (let i = 0; i < 60; i++) physics.step();
console.log(curtain.solver); // 'vertex-block'
```
- **Adaptive tearing.** A body of triangles (a cloth, a trimesh) whose material has `adaptiveTearing = true` and a `tearStrain` tears through its faces instead of at its edges: after each step a face stretched past the tear strain is cut across its greatest stretch, from a crack tip, a corner on the boundary or any corner, to the far side, where a vertex is inserted and the face beyond is split, so the mesh stays whole (Pfaff et al. 2014). The crack opens behind its tip: a vertex the crack's sides divide is copied, one for each side, its mass shared by area. So a tear runs where the stretch sends it, not where the mesh has edges, and a woven sheet, whose threads hold and whose weave shears, tears along its threads as fabric does. The body is rebuilt at each step that cuts it (`soft.onTear` hands you the new body in `pieces`); mass is kept exactly, and momentum by every cut. `maxTearsPerStep` caps the cuts a step (default 8 here); with `soft.splitOnTear = 'all'` a sheet the cuts part becomes separate bodies.

```js
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null, { gravity: [0, 0, 0] });
const soft = await SoftBodies.attach(physics);
const desc = SoftBodyDesc.cloth([-0.5, -0.5, 0], [0.05, 0, 0], [0, 0.05, 0], 21, 21).setAirDrag(false);
const material = desc.material.clone();
material.tearStrain = 0.02;
material.adaptiveTearing = true;
let sheet = soft.create(desc.setMaterial(material));
soft.onTear((event) => {
  sheet = event.pieces.at(-1) ?? sheet; // the sheet as rebuilt by the cut
});
// Thrown into shear: it tears where it stretches most.
for (let p = 0; p < sheet.numParticles(); p++) {
  const [x, y] = sheet.particlePosition(p);
  sheet.setParticleVelocity(p, [3 * y, 3 * x, 0]);
}
for (let i = 0; i < 30; i++) physics.step();
console.log(sheet.numParticles() > 441); // true: the cuts inserted and copied vertices
```
- **Snapshots.** `soft.takeSnapshot()` copies the whole soft world (every body with its particles, edges, cells, clusters, tears, pins, targets, skin, tethers and settings, the attachments to rigid bodies, and the soft kernel's memory) and `soft.restoreSnapshot(snapshot)` puts it back, so stepping on gives the same bits as the first time: a cloth can be scrubbed back and a shot resumed mid-way. It restores across bodies made, removed, torn or split since: the snapshot's bodies are the bodies again (the same `SoftBody` objects, a removed one valid again) and a body made since is removed. A surface collider removed since is made again with its settings; a drawing of a body removed since is not, so draw it again. The world's settings (`wind`, `water`, `substeps`, `iterations`, `splitOnTear`, hooks and listeners) are yours and stay as they are. Take the rigid world's beside it; `physics.takeSnapshot()` also carries the world's clock (`stepCount` and the accumulator), so a wind that reads the time blows as it did.

```js
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null);
const soft = await SoftBodies.attach(physics);
soft.wind = (point, time) => [6 + 4 * Math.sin(2 * time), 0, 0];
soft.create(SoftBodyDesc.cloth([0, 3, 0], [0, -0.2, 0], [0, 0, 0.2], 10, 8).setPinnedParticles([0, 7]));
for (let i = 0; i < 60; i++) physics.step();
const rigid = physics.takeSnapshot();
const cloth = soft.takeSnapshot();
for (let i = 0; i < 60; i++) physics.step();
const end = soft.hash();
physics.restoreSnapshot(rigid);
soft.restoreSnapshot(cloth); // back to step 60
for (let i = 0; i < 60; i++) physics.step();
console.log(soft.hash() === end); // true
```

### Cloth: woven fabric as measured

A woven sheet (`cloth`, `clothTube`, `clothAnisotropic`) is a fabric. By default it is cotton shirting as Kawabata's KES-F instruments measured it (Luible, *Study of mechanical properties in the simulation of 3D garments*, Universite de Geneve, 2008, Annex C, sample 2), and `FABRICS` holds the others: `woolGabardine`, `silk`, `canvas` and `sailcloth`. No published KES-F measurement of a canvas or a sailcloth was found, so those two are the nearest measured fabrics, a jute plain weave and a polyester plain weave, and say so in their `source`. `desc.setFabric(fabric)` or `SoftBodyMaterial.fabric(fabric)` uses one. Presets are representative, not exact: the same named fabric measured elsewhere differs by up to ten times (weave, finish, humidity), so set measured values for a fabric that must match one.

- **Stretch.** Each warp and weft thread is a spring of the fabric's tensile stiffness, 2 WT / EMT^2 per width (`fabricTensileStiffness`: the linear spring that stores the energy measured up to the strain at 500 gf/cm), held in the exact solve with its compliance, so the stretch does not depend on the iterations or the load's mass. It holds from 0 to EMT, where the real fabric (whose curve stiffens, LT under 1) is softer at the highest loads and stiffer at the lightest; past EMT a thread is held rigid at that strain (strain limiting, Provot 1995). `material.tensile = null` holds the threads inextensible, solved exactly to 0.1 percent strain (Goldenthal et al. 2007).
- **Shear.** Each cell's diagonals are springs of the fabric's shear rigidity G, G L^2 / (2 a b) on a diagonal of length L across a cell of sides a and b (G itself on a square cell), so the cloth shears alike at any resolution (`fabricShearStiffness`), damped by the shear hysteresis 2HG at 0.5 degrees through Jacobsen's equivalent viscous damping (`fabricShearDamping`).
- **Damping.** The threads lose what the fabric's tensile resilience RT says a stretch cycle loses, zeta = (1 - RT) / (4 pi) (`fabricTensileDamping`, Jacobsen 1930).
- **Bending.** Each fabric carries its KES-FB2 bending rigidity B along the warp and the weft (`fabric.bending`, gf cm^2/cm; `fabricBendingRigidity(b)` in N m). `desc.setFabric(fabric)` and `SoftBodyMaterial.fabric(fabric)` set `material.bending`, and the sheet then bends as a plate of that rigidity with no Poisson coupling, B/2 per area times its curvature squared along the warp, across it and in twist, at any resolution: each triangle's curvature comes from the dihedral angles of its three sides (Bergou et al.'s quadratic hinge vectors, "A quadratic bending model for inextensible surfaces", SGP 2006, gathered per triangle as Cohen-Steiner and Morvan's normal-cycle tensor gathers them, SoCG 2003), so the energy is quadratic in the positions and is solved exactly with the threads (the vertex-block solver takes it in its blocks, met pass by pass rather than exactly). Its bend edges rest. A cantilevered strip settles on the exact heavy elastica to (cell / length)^2, and strips of four woven fabrics hang where FAST's cantilever measured them within the KES-FB2's face and back spread (`tests/soft-bending.test.js`; linen's warp, measured 1.64 times stiffer by FAST, is the exception in `docs/limits.md`). `material.bending = null` (the default for a material that is not set from a fabric) keeps the bend edges and `bendSoftness`. The plate is flat at rest: a curved rest shape bends back toward flat. `soft.bendingEnergy()` reads the energy, J.
- **Weight.** A woven sheet given no mass weighs its fabric's areal density (`material.arealDensity`, 0.12 kg/m^2 for cotton shirting), each particle a third of the triangles around it.
- **Air.** The faces of a body of triangles feel the air (`desc.setAirDrag(on)`, default on), against `soft.wind` (a velocity, a function of the point and the time, or a flow field; still air when unset), rho the flow field's or the standard atmosphere's at the face's height. Each face is a thin plate meeting the air at an angle a: across it a normal force q A C_N(a), in attached flow Polhamus's potential and vortex lift, C_N = K_p sin a cos a + K_v sin^2 a, with K_p Helmbold's lift slope at the cloth's aspect ratio and K_v pi; past the stall, where that reaches the square plate's 1.17 (Hoerner 1965), the separated plate's 1.17 sin a / (0.56 + 0.44 sin a) (Lindenburg 2003); along it skin friction, 0.004 q A. So a face square to the air is pushed, one at a small angle is lifted across the air, and a flag or a curtain edge-on to a breeze lifts and flutters. Both loads are taken implicitly over the step, so a light cloth in a gale stays steady. `desc.setAerodynamics({ aspectRatio = 1, drag = 1.17, vortexLift = Math.PI, friction = 0.004 })` sets the law (a flag flown from its short side is `aspectRatio: 0.5`), `body.setAerodynamics(...)` changes it, and `body.stallAngle` and `body.aerodynamics` read it. The slope and stall angle match flat plates measured in a wind tunnel (Torres and Mueller 2004): within 10 percent and 5 degrees for aspect ratios 0.5 to 1. A `SailForce` on a cloth supplies its air loads instead (a vortex lattice over the whole sail), and turns this off for that cloth while it is attached.

```js
import { Physics } from '@margoengine/physics';
import { FABRICS, SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null);
const soft = await SoftBodies.attach(physics);
// A 30 by 5 cm strip of measured wool gabardine held along one end: it droops as the fabric's KES-FB2 B says.
const strip = soft.create(
  SoftBodyDesc.cloth([0, 1, 0], [0.025, 0, 0], [0, 0, 0.025], 13, 3)
    .setFabric(FABRICS.woolGabardine)
    .setPinnedParticles([0, 1, 2, 3, 4, 5]),
);
for (let i = 0; i < 120; i++) physics.step();
console.log(strip.particlePositions()[3 * 37 + 1] < 1, soft.bendingEnergy() > 0); // true true
```

```js
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null);
const soft = await SoftBodies.attach(physics);
// A 3 by 1.5 m flag on its pole side, in a 12 m/s breeze along it: it lifts off the pole line and flies.
const pole = Array.from({ length: 6 }, (_, j) => j);
const flag = soft.create(
  SoftBodyDesc.cloth([0, 5, 0], [0.25, 0, 0], [0, -0.3, 0], 13, 6)
    .setPinnedParticles(pole)
    .setAerodynamics({ aspectRatio: 0.5 }),
);
soft.wind = [12, 0, 0];
for (let i = 0; i < 120; i++) physics.step();
console.log(flag.stallAngle > 0.5); // true: a low flag stalls late
```
- **Water.** Give the bodies water (`soft.water = {elevation, flow, density}`: its surface's height over (x, z) at a time, its velocity as a flow field such as `SpectralSea`'s `water`, and its density, default 1025) and under its surface each particle takes Morison's loads (Morison, O'Brien, Johnson and Schaaf 1950): the weight of the water it displaces upward (its body's `desc.setDensity(kg/m^3)`; left out, the body displaces nothing), the water's acceleration on it and on the water it carries, that water's inertia, and the drag of the water past it. A rope's segments are cylinders across the flow (drag 1.2, Hoerner 1965; carried water that of their own volume), a cloth's faces plates (1.17) whose sheet carries the water of a disk of its area ((8/3) rho a^3). The carried water is taken implicitly (a particle under water moves with its mass and its water's), so a light cloth in the sea is as stable as in the air. A particle half out of the water takes half; the air leaves a face under the water alone. So a hose or a kelp frond sways with the waves' orbits, a curtain in a flooded cabin hangs heavy, and a weighted net sinks at its drag's speed. Measured: a rope as dense as the water stays put (to 1e-4 m), one twice as dense sinks broadside within 0.5 percent of its cylinder drag's speed, a pendulum in water swings within 0.5 percent of the period its carried water and buoyancy set, a rope as dense as the water rides an oscillating current within 1.3 percent, and a weighted tarp sinks flat within 0.3 percent of its plate drag's speed.
- **Friction.** Contacts with rigid bodies hold back a slide within Coulomb's bound, solved with the sheet's rows (staggered projections, Kaufman et al. 2008), so a box on a cloth holds below its friction angle and slides above it.
- **Tethers.** `desc.setTethers(stretch = 1)` ties every free particle to its nearest pin by its shortest distance through the body's structural and shear edges, times `stretch` (1 or more), and pulls a particle that strays outside that sphere back onto it once per pass, after the edges (long range attachments, Kim, Chentanez and Mueller 2012). A particle inside its sphere is left alone, so the tether only cuts the stretch a sheet solved with few passes shows under its own weight and a fast swing: a 2 by 10 m sheet at one pass a step stretches 0.65 percent without tethers and none with them. Ties are found again from the pins and the edges left whole after a tear, a pin change or `body.setTethers(stretch)` (`null` removes them); `body.tetheredParticles` counts them. A particle that no path reaches from a pin (a piece torn free) is not tied.

```js
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null);
const soft = await SoftBodies.attach(physics, { iterations: 1, substeps: 1 });
const top = Array.from({ length: 11 }, (_, i) => i * 51);
const curtain = soft.create(
  SoftBodyDesc.cloth([0, 10, 0], [0.2, 0, 0], [0, 0, 0.2], 11, 51).setPinnedParticles(top).setTethers(),
);
for (let i = 0; i < 120; i++) physics.step();
console.log(curtain.tetheredParticles); // 550: every free particle tied to the top row
```
- **Skinned cloth.** `desc.setSkinConstraints(maxDistance, backstop = null)` ties a garment to a character: each particle stays within its max distance (one number, or one a particle) of where the skin carries it, and with a backstop no farther than that behind the skin along its normal, so a cape swings free at its hem and cannot pass into the back. A particle with 0 rides the skin (it is pinned to it, and anchors tethers); `Infinity` is free. Each frame, before the step, hand the body the skinned mesh's vertices and normals with `body.setSkinnedPositions(positions, normals)`; `skinVertices(binding, jointMatrices)` skins them from a skeleton (linear blend skinning, four joints a vertex, column-major joint matrices as glTF uses). Over the step each skinned point moves at a steady speed, so a fast swing drags the cloth through it; `{ teleport: true }` jumps the skin and the cloth with it (a cut). `body.maxDistance(i)`, `body.backstop(i)`, `body.skinnedPosition(i)` read them back, `body.setSkinConstraints(...)` changes them (`null` lets go), and a skinned body that tears keeps its limits in each piece.

```js
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc, skinVertices } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null);
const soft = await SoftBodies.attach(physics);
// A cape 9 by 15 particles: row 0 rides the shoulders, each row below may stray 4 cm more, never 1 cm into the back.
const desc = SoftBodyDesc.cloth([-0.32, 1.5, 0], [0.08, 0, 0], [0, -0.08, 0], 9, 15);
const reach = Array.from({ length: 9 * 15 }, (_, p) => 0.04 * (p % 15));
const cape = soft.create(desc.setSkinConstraints(reach, 0.01));
// The cape's mesh bound to one joint, the character's root.
const n = 9 * 15;
const binding = {
  positions: cape.particlePositions(),
  normals: new Float32Array(3 * n).map((_, k) => (k % 3 === 2 ? 1 : 0)),
  joints: new Uint8Array(4 * n),
  weights: new Float32Array(4 * n).map((_, k) => (k % 4 === 0 ? 1 : 0)),
};
for (let frame = 1; frame <= 60; frame++) {
  const x = Math.sin(frame / 10); // the character runs left and right
  const root = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  const skin = skinVertices(binding, root);
  cape.setSkinnedPositions(skin.positions, skin.normals);
  physics.step();
}
console.log(cape.maxDistance(14)); // 0.56: the hem may swing 56 cm from the skin
```

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

A hose tied to the seabed in a swell: the waves' orbits sway it, its rubber a little denser than the sea:

```ts
import {Physics} from 'margoengine/physics';
import {SpectralSea} from 'margoengine/physics/sea';
import {SoftBodies, SoftBodyDesc} from 'margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null, {fixedTimestep: 1 / 60});
const soft = await SoftBodies.attach(physics);
// One 1 m swell of 0.12 Hz along x over 20 m of water.
const frequencies = Float64Array.from({length: 34}, (_, i) => 0.04 * 25 ** (i / 33));
const directions = Float64Array.from({length: 24}, (_, j) => (2 * Math.PI * j) / 24);
const energy = new Float64Array(34 * 24);
const bin = frequencies.findIndex((f) => f >= 0.12);
energy[bin * 24] = 1 / 2 / (((frequencies[bin + 1] - frequencies[bin - 1]) / 2) * ((2 * Math.PI) / 24));
const sea = new SpectralSea({waves: {frequencies, directions, energy, depth: 20, density: 1025}});
soft.water = {elevation: (x, z, t) => sea.elevation(x, z, t), flow: sea.water, density: 1025};
// A 6 m hose, 5 cm across, from the seabed up: rubber at 1200 kg/m^3.
const volume = (Math.PI * 0.05 * 0.05 * 0.2) / 4;
const hose = soft.create(
  SoftBodyDesc.rope([0, -20, 0], [0, -14, 0], 31).setParticleMass(1200 * volume).setDensity(1200).setPinnedParticles([0]),
);
for (let i = 0; i < 600; i++) physics.step();
console.log(Math.abs(hose.particlePosition(30)[0]) > 0.05); // true: the swell's orbits sway its free end
```

### GPU cloth (`@margoengine/physics/gpu-cloth`)

The same cloth description, stepped in compute on WebGPU and drawn straight from the buffer the compute writes: thousands of particles a frame with no readback and no upload. Build it with `SoftBodyDesc.cloth`, `clothAnisotropic` or `trimesh` (its particles, masses, pins, edges, bend edges, damping, gravity scale and radius carry over) and pick where it runs: `soft.create(desc)` on the CPU, `GPUCloth.attach(engine, desc)` on the GPU.

```ts
import {Engine} from 'margoengine/core';
import {drawGPUCloth} from 'margoengine/gltf/soft-mesh';
import {GPUCloth} from 'margoengine/physics/gpu-cloth';
import {SoftBodyDesc} from 'margoengine/physics/soft';

await GPUCloth.load();
const engine = await Engine.create(document.querySelector('canvas')!, {camera: {position: [0, 2, 4], target: [0, 0.6, 0]}});
const cloth = GPUCloth.attach(engine, SoftBodyDesc.cloth([-1, 2, -1], [0.04, 0, 0], [0, 0, 0.04], 51, 51), {wind: [2, 0, 0], colliders: [{shape: 'sphere', radius: 0.6, position: [0, 0.8, 0]}]});
drawGPUCloth(engine, cloth);
engine.start();
```

A flag tied to a pole that is a rigid body, with its debug lines in the physics debug view:

```ts
import {Engine} from 'margoengine/core';
import {drawGPUCloth} from 'margoengine/gltf/soft-mesh';
import {Physics} from 'margoengine/physics';
import {PhysicsDebugView} from 'margoengine/physics/debug-view';
import {GPUCloth} from 'margoengine/physics/gpu-cloth';
import {FABRICS, SoftBodyDesc} from 'margoengine/physics/soft';

await Physics.load();
await GPUCloth.load();
const engine = await Engine.create(document.querySelector('canvas')!, {camera: {position: [1, 2, 5], target: [1, 2, 0]}});
const physics = new Physics(engine);
const pole = physics.addBody(null, {type: 'kinematicPosition', position: [0, 1.5, 0], colliders: {shape: 'capsule', halfHeight: 1.5, radius: 0.03}});
// 1.5 m by 0.9 m of sailcloth; column j = 0 .. 9 of row i = 0 runs down the pole.
const flag = GPUCloth.attach(engine, SoftBodyDesc.cloth([0.04, 3, 0], [0.1, 0, 0], [0, -0.1, 0], 16, 10).setFabric(FABRICS.sailcloth), {physics, wind: [6, 0, 1]});
for (let j = 0; j < 10; j++) flag.attach(j, pole); // carried by the pole wherever it goes
flag.addCollider({shape: 'capsule', radius: 0.03, halfHeight: 1.5, body: pole});
drawGPUCloth(engine, flag, {material: {pbrMetallicRoughness: {baseColorFactor: [0.8, 0.1, 0.1, 1]}}});
const view = await PhysicsDebugView.attach(engine, physics);
view.add(flag); // edges coloured by strain, pins, colliders, the wind
engine.start();
```

- **A step.** Each fixed step (`timestep`, default 1/60 s) is `substeps` substeps (default 30), each a few compute passes: the particles' normals (for the drag), integrate (gravity, the wind's drag through each face, damping), pins, the edges one colour at a time (compliant distance constraints of XPBD, Macklin, Mueller and Chentanez 2016, solved once a substep in small steps, Macklin et al. 2019), tethers and colliders; after each step a surface pass writes the normals, tangents and draw vertices. No atomics: every thread writes only its own particle or its edge's two (the edges are coloured so no two of a colour share a particle), so a run repeats to the bit on one GPU and driver, and `snapshot()` / `restore()` repeat it from any step. The velocity is state of its own, so float32 positions far from the origin keep small accelerations.
- **Stiffness.** `stretchCompliance` (structural edges), `shearCompliance` (a cell's diagonals) and `bendCompliance` (the bend edges two along), in m/N: 0 is inextensible (the default for stretch and shear), and the bend default is the CPU cloth's 10 Hz bend edges on the mean particle mass. Tethers (`tethers`, default on) keep every free particle within its rest distance along the cloth, times 1 + `tetherSlack` (default 0.01), of its nearest pin (long range attachments, Kim, Chentanez and Mueller 2012), so a pinned cloth does not stretch under its own swing; they also cap an elastic `stretchCompliance` there, so turn them off for a cloth meant to stretch from its pins.
- **Pins.** `pin(i, point?)` holds a particle at a point (setting it again moves it over the next step), `attach(i, body, point?)` ties it to a rigid body, read after the physics step every frame, `unpin(i)` lets go; the description's `setPinnedParticles` are pins at their rest points. A tie is one way: the body does not feel the cloth (the CPU cloth's `attachParticle` is two way).
- **Colliders.** `addCollider({shape, ...})`, or `colliders: [...]` at construction (up to 32), takes a `sphere` (`radius`), a `capsule` (`radius`, `halfHeight`, along its local y), a `box` (`halfExtents`), a `plane` (`normal`, default up) or an `sdf` (any mesh as a signed distance field: a `MeshSDF` of `margoengine/bvh/sdf` passes as it is), each at `position` and `rotation`, in the world or on a `body`; `friction` (default the cloth's 0.4) is Coulomb's, held in position (Macklin et al. 2014). A moving collider is swept: each substep meets it where it is by then, and friction follows its surface's motion. The returned collider's `position` and `rotation` can be set each frame (a pointer's sphere), and `remove()` takes it away. The cloth keeps `thickness` from every collider (default the description's particle radius, else half its shortest edge).
- **Air.** `wind` (a velocity, a function of the cloth's time, or a `FlowField` of `margoengine/math/fields` such as the framework's shared wind, sampled once a frame at the cloth's centre, its density the air's unless `airDensity` is set) with `turbulence` (0 to 1, default 0.25: smooth gusts along and across it), `airDensity` (1.2) and `drag` (1.17): a flat plate's normal force on the air through each face, which carries both its drag and its lift.
- **Drawing.** `drawGPUCloth(engine, cloth, {material, images})` of `margoengine/gltf/soft-mesh` draws it as a PBR mesh (shadows, picking and the PBR model API included) from the cloth's own `vertexBuffer`; attach it after the cloth. Texture coordinates come from the grid (or `uvs` at construction).
- **Reading it.** `await cloth.readPositions()` reads the particles back; `positions()` gives the last read (exact on the CPU routes); `debugRender(options)` gives `{vertices, colors}` (edges by strain, `bendEdges`, `pins`, `colliders`, `normals`, `wind`) and plugs into `PhysicsDebugView.add(cloth)`; on the GPU it reads back once a frame, a frame or two behind the picture. `stats` gives the `backend`, `steps`, edge `colors` and `count`.
- **Routes.** `await GPUCloth.load()` once first (it compiles the CPU route's kernel, as `Physics.load()` does the world's). On WebGPU it steps on the GPU. On the WebGL2 compatibility layer, and before it is attached (in Node or a worker), the same passes run in the same order in a Rust kernel with SIMD (`cloth-kernel.wasm`, loaded from the package's URL); `stats.backend` says which, and `stats.work` counts what the CPU routes did (substeps, particle updates, edge solves, particle-collider tests). The CPU route matches the GPU within 1e-6 m after a step. `threads` (default 1, at most 64) shares the CPU route's passes among worker threads by a static schedule, so any count gives the same bits; load them first with `await GPUCloth.load(signal, { threads })` (a page needs cross-origin isolation for SharedArrayBuffer), and `stats.threadWork` gives each thread's share of the work.
- **Errors.** Bad input is a `MargoError` (`unsupported`, `state` for a pin or collider on a removed body, `disposed`) naming the fix, linked to [margoengine.com/errors#gpu-cloth](https://margoengine.com/errors#gpu-cloth).

| Option (default) | Meaning |
| --- | --- |
| `physics` (none) | The world whose gravity the cloth takes; set at construction. |
| `uvs` (the grid) | Texture coordinates, two a particle; set at construction. |
| `colliders` (none) | Colliders to add at once, as `addCollider` takes them; set at construction. |
| `gravity` (the world's, else [0, -9.81, 0]) | m/s^2, times the description's gravity scale. |
| `wind` ([0, 0, 0]) | m/s, `(time) => [x, y, z]` or a `FlowField`, read once a frame. |
| `turbulence` (0.25) | Gusts, 0 to 1. |
| `airDensity` (1.2), `drag` (1.17) | kg/m^3 (0 turns the air off), the plate's coefficient. |
| `stretchCompliance` (0), `shearCompliance` (0), `bendCompliance` (10 Hz) | m/N. |
| `tethers` (true), `tetherSlack` (0.01) | Long range attachments to the pins. |
| `damping` (the description's, else 0) | 1/s. |
| `friction` (0.4) | Coulomb, with every collider that has none of its own. |
| `thickness` (the particle radius) | Metres kept from colliders. |
| `timestep` (1/60), `substeps` (30) | A frame runs at most 256 substeps; a longer frame drops the rest. |
| `paused` (false) | Frames stop stepping; `step(n)` still steps. |

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
sweeps the free vertices once, and high stiffness or large meshes can need more sweeps. Unpinned
bodies preserve linear momentum during the internal elastic solve even with a fixed number of sweeps.
The default solver remains `'constraints'`. Change modes with `body.setSolver()` and use `body.solver` to read one.

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

#### Finite-chain rubber

Set `CellMaterial.rubber` for large elastic stretches and choose `'vertex-block'`. `lockingStretch` is the
dimensionless network parameter of the five-term Arruda–Boyce series. `transverseFraction` gives the share of
small-strain shear carried by the second invariant and defaults to 0. `invariantSpread` controls the curvature
of that logarithmic response and defaults to 3. Young's modulus and Poisson's ratio still set the small-strain
response. Use a reversible isotropic material. `rubber: null`, the default, gives stable Neo-Hookean elasticity.

<!-- example:node -->
```js
import { Physics } from '@margoengine/physics';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null, { gravity: [0, 0, 0] });
const soft = await SoftBodies.attach(physics);
const rubber = Object.assign(new CellMaterial(), {
  youngsModulus: 1.03e6, poissonRatio: 0.45,
  rubber: { lockingStretch: 4.52, transverseFraction: 0.305, invariantSpread: 6 },
});
const block = soft.create(new SoftBodyDesc([
  [0, 0, 0], [0.1, 0, 0], [0, 0.1, 0], [0, 0, 0.1],
]).setCells([0, 1, 2, 3], rubber).setSurface().setSolver('vertex-block').setPinnedParticles([0, 1, 2]));
block.applyParticleImpulse(3, [0, 0, 0.02]);
physics.step();
console.log(block.particlePosition(3));
physics.dispose();
```

The finite-chain law uses the same native particles and contact solver as stable Neo-Hookean material.
The local solve checks decrease of the full elastic and inertial energy. The reversible fit covers the
8% sulfur rubber measured by Treloar at large tensile strains. Those coefficients are an example, and
experiments at different strain rates or temperatures require their own material settings.
[Validation evidence](../../docs/limits.md#volumetric-vertex-blocks-soft-04)

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

#### Grain-dependent fracture

Add `strength` to the orthotropic material to let the body tear under different stresses in each
material axis and shear plane. The tensile and compressive triples use X, Y, Z order. The shear
triple uses XY, XZ, YZ order. Supply positive strengths in pascals. `CellMaterial.tearSmoothing`
filters each of these nine stresses before it can trigger a tear. Its default of zero uses the
current stress. `CellMaterial.interiorStrength` raises the thresholds for interior cells.
Set `CellMaterial.tearStrain` to zero when using these stress limits.

```ts
import { Physics } from '@margoengine/physics';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null, { fixedTimestep: 1 / 60 });
const soft = await SoftBodies.attach(physics);
const cell = new CellMaterial();
const stock = SoftBodyDesc.box([0, 1, 0], [1, 0.2, 0.2], [10, 2, 2], cell);
const beech = soft.create(stock.setOrthotropicStiffness({
  youngsModuli: [12500e6, 2050e6, 810e6],
  shearModuli: [1640e6, 1080e6, 470e6],
  poissonRatios: [0.43, 0.58, 0.61],
  strength: {
    tensile: [139.4e6, 18.2e6, 8e6],
    compressive: [61.9e6, 15.5e6, 6.7e6],
    shear: [14e6, 18e6, 15e6],
  },
}).setSolver('vertex-block'));
const stop = soft.onTear((event) => console.log(event.pieces.length));
physics.step();
console.log(beech.tornCells().length);
stop();
```

These European beech constants follow Seeber et al. (2024), using their measured mean axial
strengths and published shear inputs. [Experimental study](https://doi.org/10.1016/j.engstruct.2024.117928)

#### Progressive timber damage

Supply `strength.fractureEnergy` in joules per square metre to weaken the material progressively
under tension and shear. Each triple uses the same axis order as its strength triple. The cell
tears after that mode spends its fracture work. Compression has a ductile plateau. When a
tensile crack closes, its axis can carry compressive stress again. The mesh needs cells small
enough to resolve the authored fracture energy.

```ts
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null, { gravity: [0, 0, 0] });
const soft = await SoftBodies.attach(physics);
const h = 0.001;
const coupon = new SoftBodyDesc([[0, 0, 0], [h, 0, 0], [0, h, 0], [0, 0, h]])
  .setCells([0, 1, 2, 3])
  .setPinnedParticles([0, 1, 2, 3])
  .setOrthotropicStiffness({
    youngsModuli: [12500e6, 2050e6, 810e6],
    shearModuli: [1640e6, 1080e6, 470e6],
    poissonRatios: [0.43, 0.58, 0.61],
    strength: {
      tensile: [139.4e6, 18.2e6, 8e6],
      compressive: [61.9e6, 15.5e6, 6.7e6],
      shear: [14e6, 18e6, 15e6],
      fractureEnergy: { tensile: [10000, 710, 710], shear: [1200, 1200, 600] },
    },
  }).setSolver('vertex-block');
const body = soft.create(coupon);
const shear = 1.6 * 15e6 / 470e6;
body.setParticlePosition(3, [0, h * shear, h * Math.sqrt(1 - shear * shear)]);
physics.step();
console.log(body.isCellTorn(0)); // false: the rolling shear is beyond peak strength and still carries load
```

#### Cut through a tetrahedral solid

`soft.cutPlane(body, origin, normal)` slices through the actual volume in world space. It returns
the same event as `soft.cut`, with the live fragments and a mapping from the original vertices.
Each fragment retains the cell material and plastic rest shape. The fragments share the original
mass, rest volume and linear momentum. The plane can pass through a mesh vertex or an edge.
Use `soft.cutTriangle` for a finite incision through cells. `soft.cut` still offers a blade
that follows existing cell faces.

```ts
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null, { fixedTimestep: 1 / 60 });
const soft = await SoftBodies.attach(physics);
const solid = soft.create(SoftBodyDesc.box([0, 1, 0], [1, 0.5, 0.5], [8, 4, 4]).setSolver('vertex-block'));
const result = soft.cutPlane(solid, [0.43, 1, 0], [1, 0.2, 0]);
physics.step();
console.log(result.pieces.map((piece) => piece.volume()));
```

Start with a tetrahedral solid without separate springs, clusters, an embedded skin, or a bound
mesh. The fragments expose their closed boundary triangles when the original body has a mesh
surface. Existing particle-to-rigid attachments stay at the same point in the rigid body's frame.
When a cut duplicates an attached vertex, both copies remain attached. Use the returned pieces
to bind new rendering or constraints. If the solid has a surface collider, each piece gets a
collider following its new boundary. Friction, restitution, query groups and event settings carry over.

#### Finite incisions in a solid

`soft.cutTriangle` opens only the material inside a finite triangle in world space. An
internal incision can return one new body with two independently moving lips joined around
their perimeter. A complete cut can return several bodies. Each new body contains physical
tetrahedra and exposes their new collision and render surfaces. The same data and mass transfer
rules apply as for a full plane cut.

```ts
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null, { gravity: [0, 0, 0] });
const soft = await SoftBodies.attach(physics);
const desc = new SoftBodyDesc([[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]])
  .setCells([0, 1, 2, 3]).setSurface().setSolver('vertex-block').setSurfaceCollider({ sensor: true });
const original = soft.create(desc);
const anchor = physics.addBody(null, {
  type: 'fixed', colliders: { shape: 'sphere', radius: 0.01, sensor: true },
});
original.attachParticle(0, anchor);
const { pieces } = soft.cutTriangle(original, [[0.5, 0.2, 0.2], [0.5, 0.65, 0.2], [0.5, 0.2, 0.65]]);
physics.step();
console.log(pieces[0]?.triangles().length); // one solid with the two new incision faces
```

#### Tensile seams inside a solid

`setTensileSeam({ cell, triangle, openingStrain })` puts a breakable patch inside one
tetrahedron. The triangle uses the descriptor's rest coordinates in metres. The patch moves
with the material and opens when the strain normal to it exceeds the dimensionless
`openingStrain`. There is no seam by default. Pass `null` to clear one on the descriptor.
`slidingStrain` and `tearingStrain` add optional engineering shear limits. The first triangle
edge gives the tearing direction. Sliding is across that edge, within the plane.
The seam can open when the sum of squared strain ratios exceeds one.
`soft.onTear` reports the original cell index and the live replacement pieces.

```ts
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
const soft = await SoftBodies.attach(physics);
const solid = soft.create(new SoftBodyDesc([[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]])
  .setCells([0, 1, 2, 3]).setSurface().setPinnedParticles([0, 1, 2, 3]).setSolver('vertex-block')
  .setTensileSeam({
    cell: 0,
    triangle: [[0.5, 0.2, 0.2], [0.5, 0.65, 0.2], [0.5, 0.2, 0.65]],
    openingStrain: 0.005,
    slidingStrain: 0.006,
    tearingStrain: 0.01,
  }));
soft.onTear(({ pieces }) => console.log(pieces.length)); // one solid with an internal crack
solid.setParticleKinematicTarget(1, [2.02, 0, 0]);
physics.step();
```

#### Tensile fracture without a prescribed path

`setTensileNucleation(openingStrain)` starts a crack when a cell's largest elastic Green
strain exceeds the threshold. The crack crosses the cell centroid perpendicular to the
current principal stretch. The cell's material can continue deforming after it breaks.
The remesher splits just that cell and the neighboring faces and edges it touches.
Under continued tension, an adjacent eligible cell can extend the crack from its current
front edge. The old segment stops participating once its two lips separate.
To prescribe where the crack starts, use `soft.cutTriangle(solid, blade)` on a solid with
nucleation enabled. A bonded lip edge becomes eligible for continued tensile growth.
When the next crack plane coincides with a still-bonded face, the solver opens that face.
The fracture step chooses a cut that fits the native mesh's precision.
Nucleation is off by default. Pass `null` to clear the option on the descriptor.

```ts
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
const soft = await SoftBodies.attach(physics);
const solid = soft.create(new SoftBodyDesc([[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]])
  .setCells([0, 1, 2, 3]).setSurface().setPinnedParticles([0, 1, 2, 3]).setSolver('vertex-block')
  .setTensileNucleation(0.005));
soft.onTear(({ cells, pieces }) => console.log(cells, pieces.length)); // [0], 2
solid.setParticleKinematicTarget(1, [2.02, 0, 0]);
physics.step();
```

#### Coplanar fracture toughness

Use `setCoplanarFractureToughness([opening, sliding, tearing])` with positive energies
in J/m². A finite cut creates the two lips of a seeded crack. You can also enable
`setTensileNucleation` to start a crack by strain. Once a front exists, its matched
lip displacements drive propagation through coplanar bonded faces by toughness.
Use isotropic elastic tetrahedra at small strain. The option is off by default.

```ts
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';

await Physics.load();
const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
const soft = await SoftBodies.attach(physics);
const solid = soft.create(new SoftBodyDesc([[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]])
  .setCells([0, 1, 2, 3]).setSurface().setSolver('vertex-block')
  .setCoplanarFractureToughness([0.1, 0.2, 0.3]));
const { pieces } = soft.cutTriangle(solid, [[0.5, 0.25, 0.25], [0.5, 0.625, 0.25], [0.5, 0.25, 0.625]]);
console.log(pieces.length); // one solid with a crack that can continue under load
```

Soft cuts and tears rebuild each piece's moving query collider with the live collision settings.
A piece keeps an authored volume-collider density when its outward collision surface encloses positive
volume. Open pieces and query-only sources use triangle colliders without volume mass.

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
using load = await SailForce.attachNative(physics, sail, {wind: [10, 0, 0], grid: [5, 13], density: 1.2});
physics.step();
console.log(load.force[1] > 0); // true: lift across the wind
console.log(load.readNativeWork()?.matrixPairs);
```

`SailForce.attachNative` loads the optional SIMD lattice with one participant by default. Set `threads` to 2 or 4 in a cross-origin-isolated browser, and pass a `signal` to cancel loading. The wind cell is read each step. When cloth and air are in signed world cells, pass `frame: {cell, cellSize}` for the cloth origin in integer cells and the side length in metres. Use a getter for a moving cell. Invalid air samples and impulses fail before changing accepted sail loads or cloth velocity.

Attach native sails before registering their `RigidSolver`. Complete replay of a flexible sail uses both that rigid solver and `SoftSolver`. The synchronous constructor remains available for scalar loads and existing rigid snapshot layouts.

### Skeletal soft tissue

Load `@margoengine/physics/tissue` for tetrahedral tissue driven by fixed or kinematic bones. Each binding holds a
particle at a bone-local point in metres. Attach a `sliding` plane when the skin should travel across the underlying
body. Its `localNormal` is normalized by the solver. The normal spring uses `stiffness` in N/m and `damping` in
N·s/m. Damping defaults to local critical damping, `2 * sqrt(mass * stiffness)`. The coupling acts only in the normal
direction, and the surrounding tissue supplies its elastic resistance. Keep each bone live and fixed or kinematic in
the same rigid world. Set `cellSize` to the world cell width if the world uses a value other than 4096 m.

<!-- example:node -->
```js
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';
import { TissueSolver } from '@margoengine/physics/tissue';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';

await Physics.load();
const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
const bone = physics.addBody(null, { type: 'kinematicPosition', position: [0, 0, 0] });
const soft = await SoftBodies.attach(physics);
const tissue = soft.create(new SoftBodyDesc([
  [0, 0, 0], [0.03, 0, 0], [0, 0.03, 0], [0, 0, 0.03],
]).setCells([0, 1, 2, 3]).setSurface().setSolver('vertex-block').setPinnedParticles([0, 1, 2]));
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
  .add(new RigidSolver(), { physics })
  .add(new TissueSolver(), {
    soft,
    bindings: [{
      tissue, particle: 3, bone, localPoint: [0, 0, 0.03],
      sliding: { localNormal: [0, 0, 1], stiffness: 80 },
    }],
  })
  .couple(['rigid', 'tissue'], 'staggered');
bone.setPosition([0.004, 0, 0.002]);
world.advance(1);
console.log(tissue.particlePosition(3));
physics.dispose();
```

The solver takes bone position, rotation and velocities from the world bodies field. A sliding binding uses a
bone-local plane and a single implicit normal spring and damper before the native volumetric step. Bone motion is
prescribed. Dynamic objects can still contact the tissue through the underlying soft solver. A restored world should
supply the same bindings to its matching rigid and soft bodies before reading the snapshot.

Clean-room references for the kinematic and sliding boundary conditions:

- Joseph Teran, Eftychios Sifakis, Geoffrey Irving and Ronald Fedkiw, *Robust Quasistatic Finite Elements and Flesh
  Simulation* (2005), §§4 and 9 and Fig. 3. [Paper](https://math.ucdavis.edu/~jteran/papers/TSIF05.pdf)
- Sung-Hee Lee, Eftychios Sifakis and Demetri Terzopoulos, *Comprehensive Biomechanical Modeling and Simulation of
  the Upper Body* (2009), models attachment and the layered structure.
  [Paper](https://pages.cs.wisc.edu/~sifakis/papers/TOG09-Lee-Sifakis-Terzopoulos.pdf)
- Dinesh K. Pai et al., *The Human Touch: Measuring Contact with Real Human Soft Tissues* (2018), §§2.3 and 5,
  measures tangential skin displacement and uses an elastic coupling over a curved inner body. The local plane
  represents a patch of that sliding interface.
  [Paper](https://www.cs.ubc.ca/research/HumanTouch/HumanTouchSIGGRAPH2018.pdf)
- David Baraff and Andrew Witkin, *Large Steps in Cloth Simulation* (1998), §3 Eq. 4. Substituting the linear
  normal force `-k*d - c*v` and updating the gap with the new relative velocity gives the impulse
  `-h*(k*d + (c+h*k)*v)/(1+h*(c+h*k)/m)`.
  [Paper](https://graphics.stanford.edu/courses/cs448b-00-winter/papers/baraff_98.pdf)
- Breannan Smith, Fernando de Goes and Theodore Kim, *Stable Neo-Hookean Flesh Simulation* (2018), supplies the
  native volume constitutive law. [Paper](https://www.tkim.graphics/NEO/StableNeoHookean2018.pdf)

#### Layered muscle, fat and skin

`createLayeredTissue(soft, desc, { cells, materials })` applies one anatomical label per tetrahedron to the
description and creates a single body with shared vertices across the layers. Label cells `'muscle'`, `'fat'` or
`'skin'` in the order passed to `setCells`. Provide a reversible Neo-Hookean `CellMaterial` for each label you
use. Each layer contributes its own density in kg/m³, Young's modulus in Pa, Poisson ratio and deformation damping.
When no particle mass was authored, each cell contributes a quarter of its rest mass to each corner. Read a copy
of the effective authored material with `tissue.cellMaterialAt(index)`. Calling `setCellMaterial` on the body
replaces the layered elastic coefficients with one material.

<!-- example:node -->
```js
import { Physics } from '@margoengine/physics';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';
import { createLayeredTissue } from '@margoengine/physics/tissue';

await Physics.load();
const physics = new Physics(null);
const soft = await SoftBodies.attach(physics);
const material = (density: number, youngsModulus: number) =>
  Object.assign(new CellMaterial(), { density, youngsModulus });
const desc = new SoftBodyDesc([
  [0, 0, 0], [0.1, 0, 0], [0, 0.1, 0], [-0.1, 0, 0], [0, -0.1, 0], [0, 0, 0.1],
]).setCells([0, 1, 2, 5, 0, 2, 3, 5, 0, 3, 4, 5]).setSurface().setSolver('vertex-block');
const tissue = createLayeredTissue(soft, desc, {
  cells: ['muscle', 'fat', 'skin'],
  materials: {
    muscle: material(1060, 6000),
    fat: material(900, 2500),
    skin: material(1120, 18000),
  },
});
console.log(tissue.mass(), tissue.cellMaterialAt(1).youngsModulus);
physics.dispose();
```

This coupon uses example material values. Author anatomical material coefficients for the part and loading
regime. Geometric cuts keep each child cell's parent material and apportion mass by the contributing layer
densities. The tissue solver still takes the bindings belonging to each authored body at creation time.

Lee, Sifakis and Terzopoulos (2009), *Comprehensive Biomechanical Modeling and Simulation of the Upper Body*,
§§3–4 models separate anatomical structures and tissue-to-skeleton attachments. Smith, de Goes and Kim (2018),
*Stable Neo-Hookean Flesh Simulation*, supplies the passive local material law used by each cell.
[Lee et al.](https://pages.cs.wisc.edu/~sifakis/papers/TOG09-Lee-Sifakis-Terzopoulos.pdf)
[Smith et al.](https://www.tkim.graphics/NEO/StableNeoHookean2018.pdf)

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

### Soft volumes from any mesh (`SoftBodyDesc.volume`)

A soft ball, a jelly or a balloon straight from a mesh. It squashes and bounces on the ground, trades momentum with rigid bodies both ways, keeps its
volume (or a sealed gas), and takes `applyImpulse`, `applyImpulseAtPoint`, `applyRadialImpulse`, `addForce` and
`addParticleForce` as a body of its mass would.

<!-- example:node -->
```js
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';
import { sphereGeometry } from '@margoengine/geometry/primitives';

await Physics.load();
const physics = new Physics(null);
physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [5, 0.5, 5] } });
const soft = await SoftBodies.attach(physics);
const ball = soft.create(SoftBodyDesc.volume(sphereGeometry(0.4, 16, 12)).setTranslation([0, 1.5, 0]));
for (let i = 0; i < 120; i++) physics.step();
console.log(ball.centerOfMass(), ball.surfaceVolume());
```

- **The mesh.** A `@margoengine/geometry` primitive (`{positions, indices, uvs}`), a core `Geometry` (6 floats a vertex),
  a loaded glTF primitive (`model.primitives[i]` of `@margoengine/gltf/pbr`, 20 floats a vertex, in its node's own space),
  or `{vertices, indices, stride}` with the position first. It must be closed and wound counter-clockwise seen from
  outside once welded. Vertices within `weld` metres become one particle, so a sphere split at its UV seam and poles, or
  a box with a vertex per face, is one surface. `body.sourceMesh` keeps each source vertex's particle and texture
  coordinates: `drawSoftBody(engine, ball, {material})` from `@margoengine/gltf/soft-mesh` draws the source mesh,
  seams and texture kept.
- **Options**, all with defaults: `weld` 1e-5 m; `stiffness` 20 Hz, the natural frequency of its edge and bend springs
  (lower is softer, 0 holds them rigid); `damping` 0.1, their damping ratio (1 lands dead); `density` 1000 kg/m^3, so its
  mass is density times its volume (and it floats at that density in `SoftBodies.water`); `radius` 0.01 m, the contact
  thickness of its surface; `pressure`, an absolute fill pressure in Pa that makes it a sealed shell of gas (see below)
  in place of a held volume, with `ambientPressure` (default 101,325 Pa) outside.
- **Two tiers, one option.** `tier: 'surface'` (the default) is the fast tier above: the mesh's own vertices are the
  particles. `tier: 'cells'` is the high-fidelity tier: the mesh is filled with tetrahedra fitted to its surface by
  isosurface stuffing (Labelle and Shewchuk 2007; a body-centred cubic lattice of `cellSize` metres, default an eighth
  of the mesh's smallest extent, cut and warped onto the surface, dihedral angles within 10.8 to 164.8 degrees), elastic
  by `material` (a `CellMaterial`, default 100 kPa rubber; its density is `density`), solved by the vertex-block solver,
  and the source mesh rides in the cells as a skin (`body.meshVertices()`), drawn by `drawSoftBody` with its own uvs. Its
  squash and contact follow the measured modulus: a hemisphere of 1 MPa rubber pressed on the floor meets Hertz contact
  within 6% at the default 8 pieces of 2 passes (`setSolver('fem')`: within 10%), and follows its 3/2 power on a held-out
  load. `stiffness`, `damping` and `pressure` are the surface tier's (a gas needs a hollow shell).

  <!-- example:node -->
  ```js
  import { Physics } from '@margoengine/physics';
  import { CellMaterial, SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';
  import { sphereGeometry } from '@margoengine/geometry/primitives';

  await Physics.load();
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [5, 0.5, 5] } });
  const soft = await SoftBodies.attach(physics, { substeps: 20, iterations: 10 });
  const rubber = Object.assign(new CellMaterial(), { youngsModulus: 2e6, poissonRatio: 0.45 });
  const mesh = sphereGeometry(0.1, 16, 12);
  const ball = soft.create(SoftBodyDesc.volume(mesh, { tier: 'cells', material: rubber, density: 1100 }).setTranslation([0, 0.5, 0]));
  for (let i = 0; i < 30; i++) physics.step();
  console.log(ball.numCells(), ball.centerOfMass());
  ```
- **A rubber sheet for the shell.** `membrane: {shearModulus, thickness}` (Pa and metres) with a `pressure` makes the
  surface tier's shell an incompressible neo-Hookean membrane (Adkins and Rivlin 1952, Treloar 1975) in place of its
  springs, solved with its gas by vertex block descent: a balloon or a pressurised ball inflates to the stretch its fill
  and its sheet balance at, and stiffens as the sheet does. A sphere of rest radius R stretched by lambda holds
  2 mu H / R (1 / lambda - 1 / lambda^7) over the air outside, which peaks at lambda = 7^(1/6); the tests hold the ball to
  it within 1e-4 of the stretch and 0.1% of the pressure, its stiffness dp / dlambda within 1%, on a held-out sheet too.
  The sheet has no bending stiffness, so the gas keeps its shape.

  <!-- example:node -->
  ```js
  import { Physics } from '@margoengine/physics';
  import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';
  import { sphereGeometry } from '@margoengine/geometry/primitives';

  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const soft = await SoftBodies.attach(physics);
  const sheet = { shearModulus: 300e3, thickness: 0.5e-3 };
  const balloon = soft.create(SoftBodyDesc.volume(sphereGeometry(0.1, 24, 16), { pressure: 150_000, membrane: sheet }));
  for (let i = 0; i < 120; i++) physics.step();
  console.log(balloon.gasState());
  ```
- **Venting and bursting.** `body.openVent({particle, area})` opens a hole in a gas shell: the gas leaves as an ideal gas
  through an orifice (choked above a pressure ratio of 1.89 for air, `dischargeCoefficient` default 0.61, a sharp-edged hole
  in a thin wall), the fill's pressure falls as it goes, and the jet pushes the shell the other way, so a loose balloon flies
  round the room; `gasConstant` (287.05 J/(kg K)), `temperature` (293.15 K) and `heatCapacityRatio` (1.4) name the gas.
  `closeVents()` shuts them. A membrane given `burstStretch` bursts once a triangle stretches that far: the sheet tears there,
  its gas goes and `soft.onBurst(listener)` reports it. `ventFlow`, `ventThrust` and `ventStep` are the flow laws on their
  own.

  <!-- example:node -->
  ```js
  import { Physics } from '@margoengine/physics';
  import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';
  import { sphereGeometry } from '@margoengine/geometry/primitives';

  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const soft = await SoftBodies.attach(physics);
  const sheet = { shearModulus: 300e3, thickness: 0.5e-3, burstStretch: 1.6 };
  const balloon = soft.create(SoftBodyDesc.volume(sphereGeometry(0.1, 24, 16), { pressure: 150_000, membrane: sheet }));
  soft.onBurst(({ pressure }) => console.log('burst at', pressure, 'Pa'));
  balloon.openVent({ particle: 0, area: 2e-5 });
  for (let i = 0; i < 120; i++) physics.step();
  console.log(balloon.gasState()?.pressure, balloon.centerOfMass());
  ```
- **Directing it for film.** `body.cue({at, ...})` places an event on the soft world's clock (`soft.time`, seconds): an
  `impulse` on the whole body, a `poke` (an impulse falling off from a point), a `blast` from a centre, a `vent`, a
  `closeVents` or a `target` shape. It runs at the start of the first step that begins then or later, in the order placed,
  and replays the same after a snapshot. `body.setTargetShape(shape, {frequency})` (default 2 Hz) draws the body toward a
  shape (one point a particle) fitted to where it is, its centre of mass and best-fit turn (shape matching's goal), so the
  pulls add to no force and no torque: it squashes, stretches or poses as directed while it falls, bounces and spins as the
  physics says. `null` lets it go; `pendingCues()` and `clearCues()` read and drop the cues.

  <!-- example:node -->
  ```js
  import { Physics } from '@margoengine/physics';
  import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';
  import { sphereGeometry } from '@margoengine/geometry/primitives';

  await Physics.load();
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [5, 0.5, 5] } });
  const soft = await SoftBodies.attach(physics);
  const jelly = soft.create(SoftBodyDesc.volume(sphereGeometry(0.3, 16, 12), { stiffness: 4 }).setTranslation([0, 0.4, 0]));
  const tall = jelly.particlePositions().map((v, i) => (i % 3 === 1 ? v * 1.5 : v / Math.sqrt(1.5)));
  jelly.cue({ at: 0.5, poke: { impulse: [0, 0, 2], point: [0, 0.4, -0.3], radius: 0.2 } });
  jelly.cue({ at: 1, target: { shape: tall, frequency: 6 } });
  for (let i = 0; i < 120; i++) physics.step();
  console.log(soft.time, jelly.centerOfMass());
  ```
- **Anchoring.** Every `SoftBodyDesc` setting applies to the description it returns: `setPinnedParticles([i])` pins a
  particle, `setParticleKinematicTarget(i, position)` on the body drags one, `attachParticle(i, rigidBody)` ties
  one to a rigid body; `setMass`, `setVolumeFactor` (inflate or deflate), `setGravityScale`, `setAirDrag` (default on:
  a closed body takes the air's pressure on its windward faces, a sphere's drag coefficient 0.525 against the 0.47
  measured, Achenbach 1972) and the rest.
- **Water and wind.** In `soft.water` a soft volume floats where Archimedes says: the water's hydrostatic pressure on its
  faces below the waterline lifts it by the weight of the water it displaces (`ball.displacedVolume()`), it carries a
  sphere's added mass and takes drag on its upstream faces. `soft.wind` pushes it on its windward side.
- **Debug view.** `PhysicsDebugView.add(ball)` (`@margoengine/physics/debug-view`) draws its edges coloured by strain
  (green at rest, red stretched, blue squeezed), a tick at each contact, and a cross at its centre of mass, white at its
  rest volume and redder as it swells, bluer as it is squeezed (full colour 20% off). `ball.debugRender(options)` gives
  the same lines.
- **Errors.** A mesh that is missing, open, wound inward, not triangles or not finite, or an option out of range, throws
  `MargoError` code `unsupported` with the fix and a link to [soft-volumes](https://margoengine.com/errors#soft-volumes).
- **Limits.** The soft kernel keeps positions in float32: damped springs lose up to about 1e-3 of the body's momentum
  over a few seconds near the origin, and more far from it (KB-SOFT-F32MOMENTUM1, `docs/known-bugs.md`). A gas shell is
  isothermal: a vent's flow is isentropic through the hole but the gas left inside keeps its temperature (`docs/limits.md`).

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

Bad input to a body, collider, shape, query or world setting is a `MargoError` (code `unsupported`) whose message names the input and its fix and links [its help entry](https://margoengine.com/errors#physics-bodies); a mesh, hull, heightfield, mesh-mass or decomposition input links [the mesh entry](https://margoengine.com/errors#physics-meshes). Branch on `error.code`, not the message.

| Export | Purpose |
| --- | --- |
| `Physics` | The world and engine plugin: `update`, `step`, `sync`, `addBody`, `addJoint`, `createCharacterController`, `raycast`, `raycastAll`, `shapeCast`, `projectPoint`, `intersectPoint`, `intersectShape`, `touching`, `contactPoints`, `on`, `debugRender`, `dispose`; `kernel` is the solver's world, with its columns, `hash`, `snapshot` and `restore` |
| `PhysicsBody` | Pose, teleport (`setPosition`, `setRotation`), kinematic targets (`setNextPosition`, `setNextRotation`, and `setNextVelocity` for a smooth path), velocities, `addForce`, `addForceAtPoint`, `applyImpulse`, `applyImpulseAtPoint` (both forms take a point too), `addTorque`, `applyTorqueImpulse`, `resetForces`, `resetTorques`, `appliedForce`, `appliedTorque`, `setAdditionalMass`, `setMassProperties`, `mass`, `centerOfMass`, `principalInertia`, `inertiaFrame`, `additionalPgsIterations`, `additionalSubsteps`, sleep and wake, `gravityScale`, `ccd`, locks (`lockTranslations`, `lockRotations`, `enabledTranslations`, `enabledRotations`), `addCollider`, `removeCollider`, `remove`, `colliders` |
| `PhysicsCollider` | What `body.colliders`, events and query hits hand you, one object per collider: `shape`, `body`, `handle`, `valid`, `boundingRadius`, read and set `friction`, `restitution`, `density`, `sensor`, `enabled`, `collisionGroups`, `solverGroups`; `translation`, `rotation`, `translationWrtParent`, `rotationWrtParent`, `halfExtents`, `radius`, `halfHeight`, `vertices`, `indices`, `containsPoint`; for `voxels`, `setVoxel`, `combineVoxelStates`, `propagateVoxelChange`. It throws a `state` error once removed. |
| `PhysicsJoint` | `setLimits`, `setMotor`, `setRotationMotor` (spherical joints: a spring toward a rotation), `setAxisLimits` and `setAxisMotor` (generic joints: one axis), `clearMotor`, `anchorA`, `anchorB`, `contactsEnabled`, `remove` |
| `CharacterController` | `move(desired)` per fixed step, `grounded`, `collisions`, `platform`, `innerBody`, `onContact`, `dispose` |
| `DynamicCharacter` | `update()` per fixed step, `setTargetVelocity`, `setFacing`, `jump`, `grounded`, `platform`, `groundNormal`, `dispose` |
| `Rope` | `new Rope(physics, options)`: `segments`, `joints`, `segmentLength`, `points(out?)`, `remove`, `valid` |
| `Vehicle` | `new Vehicle(physics, chassis, options)` or the tuned four-wheeled `Vehicle.car(physics, chassis, options)`: `engineForce`, `steering`, `brake`, `setInput`, `speed`, `wheel(i)`, `wheelLocalPose(i)`, `wheelCount`, `debugRender`, `writeMotionState`, `readMotionState`, `dispose` |
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
| `substeps` | `8` | Equal pieces each step is split into; more is stiffer stacks and joints. `iterations` (default 2) are the solver passes in each. `physics.substeps` reads and sets it later (`solverIterations` is its old name); `body.additionalPgsIterations` (default 0) adds passes for that body's island alone, and `body.additionalSubsteps` (default 0, Rapier's `additional_solver_iterations`) substeps: the island steps at `substeps` plus the most any of its bodies asks, the rest of the world as before |
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
```

A `Physics` on a shared memory does the same through the engine's world: `await physics.useThreads(4)` starts the workers, `await physics.stepAsync()` runs one fixed step like `step()` (the same bits, events, breaks and attachments) with its islands solved across them, `physics.threadCount` reads the count and `physics.endThreads()` stops them. Make it as `new Physics(null, {arena: new Arena(worldMemory(true))})` after `await Physics.load({threads: true})`.

Gravity defaults to `[0, -9.81, 0]` (`world.setGravity(x, y, z)`) and each step runs 8 substeps (`world.substeps`) of 2 solver passes (`world.iterations`). A force in `forceX` and the columns beside it stays until you clear it and reaches every substep; an impulse in `impulseX` lands once, before the first. A body's mass, centre of mass and inertia come from its colliders; write `additionalMass` and call `world.updateMass(body)` to add weight, which is spread as the colliders are, so it scales the inertia too. A dynamic body with no mass does not fall. `world.removeBody(body)` and `world.removeCollider(box)` free their rows, and a later add takes the last one freed; a collider's row comes back after the next step.

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

`ccd: true` on `addBody`, or `body.ccd = true`, turns on continuous collision for a body (default off): after each step a dynamic body that moved further than its thinnest piece is thick is swept from where the step began to where it ended and put back to its first touch, its velocity kept, so a fast thin body cannot pass a wall, a mesh or a height field. A slow body moves exactly as it would without it. `body.ccdActive` is true when the last step's sweep checked the body. Within the step, a body with `ccd` that closes on or turns into another faster than its contact points can follow (a spinning bar striking a plate) has its island cut each substep at the time of impact and find its contact points again, so the knock it takes matches a much finer step; a body that never closes that fast, or rolls, is stepped exactly as before. Islands with joints, kinematic bodies or mesh pairs are not cut yet (see `docs/known-bugs.md`, KB-PHYS-CCDKNOCK2).

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

A `trimesh` with a `density` or `mass` must be a closed surface wound outwards, and throws otherwise. Pass `massFallback: 'winding'` to take the mass of a mesh that is not: a closed mesh wound inside out is flipped (signed tetrahedra, Mirtich 1996), and an open or non-manifold mesh, common in generated models, gets the volume its generalized winding number says is inside (Jacobson et al. 2013, on a voxel grid), all in f64. The collider then has that mass, centre of mass and principal inertia. `estimateMeshMassProperties(vertices, indices, {density, mass, resolution})` gives the same numbers (`mass`, `volume`, `centerOfMass`, `principalInertia`, `inertiaFrame`, and `method`: `'exact'`, `'flipped'` or `'winding'`) without a body; `resolution` (4 to 64, default 16) is the grid for an open mesh.

```js
import {estimateMeshMassProperties} from 'margoengine/physics';

// A unit cube with its top face missing: ten of its twelve triangles.
const vertices = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const indices = [0, 2, 1, 0, 3, 2, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
const open = estimateMeshMassProperties(vertices, indices, {density: 1000});
console.log(open.method, open.volume.toFixed(1), open.mass.toFixed(0)); // winding 1.0 1000
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

A `convexHull` takes `points` (flat x, y, z numbers), or `geometry`, or the body's mesh when it has neither, scaled with the mesh. The solver builds it by Quickhull: points inside, repeats and points within 2.5e-5 of the hull's size of a face are dropped, triangles in one plane become one face of up to 256 corners, and colliders built from the same points share one hull. `convexHull(points)` returns the `vertices` and `faces` it builds, for drawing or checking; it throws a `MargoError` (code `unsupported`, linking [its help entry](https://margoengine.com/errors#physics-meshes)) naming the fix for fewer than four points or points that span no volume.

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

After each step a pair that began or stopped touching fires `contactstart` or `contactend`, or `intersectionstart` or `intersectionend` when either collider is a sensor, with both bodies, meshes and colliders. With a `contactcontinue` listener, every solid pair that touched before the step and still touches after it fires `contactcontinue` once that step (never in the step it starts or ends, never for sensors, in the order of the pair rows); with no listener it costs nothing. A sensor sees overlaps and pushes nothing, and it sees kinematic and fixed bodies too. Two fixed bodies never meet, sensor or not. A collider stays quiet with `events: false` when the other side has it too. A pair of sleepers says nothing. A fast body with `ccd: true` that passes through a sensor inside one step fires `intersectionstart` and `intersectionend` for it, though it is in it at neither end of the step. A collider or body removed while it touches ends the contact at once, and the end event, `removed: true` (Rapier's `CollisionEventFlags::REMOVED`), is delivered at the end of the next step, still naming both colliders. `collisionGroups` keeps a pair apart; `solverGroups` lets it be seen and fire events without being solved. Both take a packed `collisionGroups(memberships, filter)` number (16 + 16 bits, as Rapier's JavaScript build packs them) or `interactionGroups(memberships, filter, testMode)`, 32 bits wide as Rapier's Rust `InteractionGroups` is: masks or lists of group indices 0 to 31, tested by `'and'` (each side's memberships share a bit with the other's filter, the default) or `'or'` (either way; used only when both colliders ask for it, and a mixed pair tests by `and`). A collider left at its default is in every group. `collider.interactionGroups()` and `solverInteractionGroups()` read them back, and scene queries take either form as `groups`. `contactFilter(a, b)` runs inside the step for each candidate pair of bodies: it may read the world and must not change it, so a step run from it throws, and false lets the pair pass and keeps its sensor events quiet. A body of higher `dominance` is a wall to a dynamic body of lower dominance, in contacts only, and floors still hold it. `body.enabled = false` takes a body out of the world: it keeps its pose and speed, nothing wakes it, its touches end and what rested on it falls, and its joints rest until it comes back, awake. `collider.setEnabled(false)` does the same for one collider, which keeps its mass.

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

A `contactModifier` in the `Physics` options is a contact modification hook: it is called, each step, for every touching pair that has a collider with `modifyContacts: true`, after the pair's friction and bounce are set and before it is solved. It may change `contact.friction`, `contact.restitution` and `contact.normal` (world space, from `contact.first` to `contact.second`), keep a word with the pair in `contact.userData` (0 when the pair is made, lasting as long as the pair does), move a point with `contact.point(k)` (`anchorA` and `anchorB` from each body's centre of mass in its frame, and `distance`, which moves the point on the second body along the normal so a larger distance lets go and a smaller one presses harder), call `contact.clear()` to drop the pair's contacts for the step, set `contact.surfaceVelocity` (world space, a conveyor: friction brings the sliding of the second collider's surface against the first's to it, for this step), or `contact.oneWay(platform, direction, angle)` to keep only the contacts whose normal, taken from the platform to the other collider, is within `angle` (a quarter turn by default) of `direction`. The object is reused: do not keep it. Rapier's JavaScript has no such hook. `contactFilter` (above) remains the pair filter for contacts and intersections.

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

`physics.addJoint(bodyA, bodyB, options)` holds `fixed`, `spherical`, `revolute`, `prismatic`, `rope` and `spring` joints, and `generic` joints, with `limits`, `motor`, `axis` or `frameA` and `frameB`, `locked`, `motors`, `contactsEnabled`, `joint.setLimits`, `setMotor`, `setRotationMotor`, `setAxisLimits`, `setAxisMotor`, `clearMotor`, `remove`, and the same errors. A joint keeps its two bodies from colliding unless `contactsEnabled` is true, and leaves with either body. A `generic` joint is the joint its locks make, bit for bit: all six are a `fixed` joint, the linear three a `spherical` one. An axis with one free turning axis reads its angle past a whole turn; with two or three free, each reads its part of the rotation vector from frame A to frame B. A limit or motor on a locked axis throws a `MargoError` (code `unsupported`), and `clearMotor` stops every axis's motor. A `rope` is slack inside its `length` and stops dead at it, and a `spring` is Hooke's law in implicit form, so any stiffness is stable, at the price of the decay implicit Euler brings: 1 / sqrt(1 + (w h)^2) a substep, about 23 percent of the amplitude in 10 s for a spring of 5 rad/s.

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

Locks along a chain are solved exactly, so a chain of 50 hung straight holds a 1000 to 1 end mass to under 1e-5 of its length, at rest and swung at 3 m/s. A chain laid out level and let fall holds 1e-4 of its length through its first swing under a 1000 to 1 end mass too: the pull of a taut joint across its arm is part of the inertia it turns a light link by, so no pull turns a link faster than a substep can follow. Past that swing the chain goes slack at each turn and snaps taut, and a joint then opens by millimetres (4 mm within 20 s; under 1 mm as a multibody), as nothing damps the turning a snap leaves (`docs/known-bugs.md`). A branch or a closed loop settles pass by pass, so it holds under its own weight and gives way a little under a far heavier body: the numbers are in `docs/limits.md`.

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

A concave mesh for a dynamic body goes through `convexDecomposition` from `margoengine/physics/decomposition`, its own entry, so a game that never decomposes never loads it. It takes a closed mesh (`vertices` and `indices`, or a geometry; equal positions are welded when the mesh is only closed after that, and one wound inside out is turned) and returns `{shape: 'convexDecomposition', parts, concavity}`, which is a collider on this entry and on the root one. It is the method of Wei, Liu, Ling and Su (ACM TOG 2022, CoACD): a part is cut by the axis plane a tree search over the next four cuts likes best, until each part's concavity, the larger of the widest gap between the part's surface and its hull's and 0.3 times the radius of a ball with the volume the hull adds, is under `concavity`, a share of the mesh's largest side (default 0.05); then neighbours that share a whole cut face merge while they stay under it. `maxConvexHulls` (default 64) caps the parts, cutting the least convex first; `borderRadius` (default 0) rounds every part, as Rapier's `round_convex_decomposition` (V-HACD's voxel terms `alpha`, `beta`, `resolution` and fill mode have no counterpart in a method that cuts the mesh itself); `planes` (20 per axis), `iterations` (500), `depth` (4) and `merge` (true) are the paper's settings; `seed` (0) makes a result repeat bit for bit, on any machine: there is no wall-clock bound by default, since the settings already bound the work; `signal` (an `AbortSignal`, such as `AbortSignal.timeout(60_000)`) stops it with the signal's reason, a timeout's as a `timeout` `MargoError`, never a half-done answer (`timeLimit` in milliseconds is deprecated for `signal`). It is build-time work, seconds for a thousand triangles, so decompose once and keep the parts. `decompositionConcavity(mesh, parts)` scores any set of convex parts by the paper's measure, Rapier's included.

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

`physics.setSolver(options)` tunes the solver from the next step on, and `physics.solver` reads it. Contacts are soft constraints (Catto 2011): `contactHertz` is their stiffness as a frequency (default 120, and never above an eighth to a quarter of the substep rate), `contactDamping` their damping ratio (default 10), `contactMaxPush` the fastest a depth is pushed out in m/s (default 3) and `allowedPenetration` the depth left alone in metres (default 0.0002). Joints close `jointShare` of an error a substep where the solve is exact (default 1) and `jointLooseShare` where they meet in a branch or ring (default 0.2), at most `jointMaxPush` units a second (default 3). `warmStart` (0 to 1, default 1) is the share of each carried contact impulse kept at the start of a substep. The settings are part of a snapshot, a value out of range throws a `MargoError` (code `unsupported`, linking [its help entry](https://margoengine.com/errors#physics-bodies)), and a call changes nothing when it throws.

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

`PidController` drives a body toward a target pose. `linearCorrection(dt, body, target, targetVelocity?)` and `angularCorrection(dt, body, target, targetAngularVelocity?)` return the acceleration it asks for: `kp` times the error, plus `ki` times the error summed over time, plus `kd` times the speed error. `applyLinear` and `applyAngular` land it as an impulse of mass (or world inertia) times acceleration times `dt`, so a heavy body and a light one follow the same path, and `apply(dt, body, {position, rotation}, {linear, angular})` drives a whole pose. Call once a step with the step's length. Give the target's speed to follow a moving target with no lag; without it a PD lags by `kd * v / kp`. Gravity is not compensated: the integral takes it up.

| Option | Default | Meaning |
| --- | --- | --- |
| `kp`, `ki`, `kd` | 1, 0, 0 | Gains, in 1/s², 1/s³ and 1/s. They are the linear gains (`pid.kp` and so on); finite and at least 0 |
| `angular` | the linear gains | `{kp, ki, kd}` of the angular part (`pid.angularKp`, `angularKi`, `angularKd`) |
| `axes` | all | One `[x, y, z]` mask of world axes for both parts, or `{linear, angular}` with one each; `setAxes` changes it and `pid.axes` reads it |
| `maxLinear`, `maxAngular` | `Infinity` | The largest acceleration asked for, m/s² and rad/s². A longer command keeps its direction, and its integral holds while it is at the cap, so it does not wind up |

`reset()` clears the integrals, and `linearIntegral` and `angularIntegral` read them. `PdController` is the same with no integral: `linearCorrection(body, target, targetVelocity?)` and the rest take no step until they land. `pdErrors(body, pose, velocity?)` reads how far a body is from a target, `{linear, angular, linearVelocity, angularVelocity}`, and `pd.correction(errors)` or `pid.correction(dt, errors)` turns errors into accelerations. The angular error is twice the vector part of the short turn to the target, which is the angle in radians to 0.1 percent below 0.1 radian and a little under it beyond.

```ts
import {PdController, PidController, Physics, pdErrors} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
const body = physics.addBody(null, {colliders: {shape: 'sphere', radius: 0.25, density: 1000}});
const pid = new PidController({kp: 60, ki: 400, kd: 16, maxLinear: 40});
for (let i = 0; i < 600; i++) {
  pid.applyLinear(1 / 60, body, [0, 2, 0]); // hold 2 m up against gravity
  physics.step();
}
console.log(body.position[1].toFixed(2)); // '2.00'

// A PD on the linear x axis only, following a target that moves at 1 m/s.
const pd = new PdController({kp: 16, kd: 8, axes: {linear: [true, false, false], angular: [false, false, false]}});
const errors = pdErrors(body, {position: [1, 2, 0]}, {linear: [1, 0, 0]});
console.log(pd.correction(errors).linear); // [ 24, 0, 0 ]
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

A joint reads and sets what it was made with. `userData` (an option, then a property) carries anything you want to find again; `enabled = false` takes a joint out of the solve and `true` puts it back, with its limits and motors as they were; `joint.force` and `joint.torque` are the force and couple, in newtons and newton metres in the world's axes, that the joint applied to `bodyB` in the last step, so a joint that holds a 10 kg weight reads 98.1 N up. `setAnchorA`, `setAnchorB` and `setFrames(frameA, frameB)` move a joint's anchors and turn its frames after creation, and `flip()` swaps its two bodies with their anchors and frames and mirrors the limits, motor targets and angle, so the joint holds the same pose from the other body; it flips a hinge, a slider, a ball, a fixed joint, a rope, a spring and a generic joint with one free turning axis, and refuses what does not mirror axis by axis (a cone, a rotation motor, a joint of a multibody, limits on two turning axes) with a coded `MargoError` that says so. `physics.getJoints()` and `physics.jointCount` list the world's joints.

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

`physics.takeSnapshot()` copies the whole world (every body, collider, joint, contact, warm start and sleep timer, and its clock: `stepCount` and the accumulator) and `physics.restoreSnapshot(snapshot)` puts it back, as Rapier's `takeSnapshot`, so stepping on gives the same bits as the first time. The snapshot holds the kernel's rows, not your objects: handles, `userData`, meshes, controllers and listeners stay as they are, and a restore needs the same bodies, colliders and joints to exist, or it throws and changes nothing.

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

### Motor joint

`type: 'motor'` drives body B toward a pose relative to body A, Box2D's motor joint: `linearOffset` is where B's anchor should sit in A's anchor frame and `angularOffset` how B should be turned in A's frame (a unit quaternion). A critically damped spring of `frequency` hertz (default 5, `dampingRatio` 1) pulls it there per kilogram, so a light body and a heavy one follow alike, and its pull is capped at `maxForce` newtons and `maxTorque` newton metres (default `Infinity`) as vectors: a pull on a slant is no stronger than one along an axis. Nothing is locked, so past its caps the body is free: a character's root following its animation, a held prop following a hand, a hook following a crane's target. `joint.setMotorTarget(linearOffset, angularOffset?)`, `setMotorCaps(maxForce, maxTorque)` and `setMotorSpring(frequency, dampingRatio?)` change it as it runs, and `joint.motorTarget` reads the target. Under gravity a body hangs `g / (2 pi frequency)^2` below its target (9.9 mm at 5 Hz); a capped pull cannot brake as hard as the spring asks, so a body pulled far at a low cap overshoots and swings in.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null);
const hand = physics.addBody(null, {type: 'kinematicPosition', position: [0, 1.2, 0]});
const cup = physics.addBody(null, {position: [0.5, 0.2, 0], colliders: {shape: 'cylinder', radius: 0.04, halfHeight: 0.05, mass: 0.3}});
physics.addJoint(hand, cup, {type: 'motor', linearOffset: [0.1, 0, 0], maxForce: 20, maxTorque: 2});
for (let i = 0; i < 120; i++) physics.step();
console.log(cup.position.map((v) => v.toFixed(2)).join(' ')); // '0.10 1.19 0.00'
physics.dispose();
```

### Multibody joints

`physics.addMultibody(root, links)` holds a tree of bodies to reduced coordinates, (multibody joints). Each link names its `body`, the body it hangs from (`parent`, default the link before it) and a `joint` of locks: `fixed`, `revolute`, `prismatic`, `spherical` or `generic`. The joints are made for you and are ordinary joints too, with their limits, motors and break limits. The tree adds what plain joints cannot give: every substep the speeds of the links are projected onto the joint space (the least change of kinetic energy that keeps every joint closed, the normal equations of Featherstone's joint-space inertia matrix, 2008, solved over the tree with articulated-body inertias in time proportional to its links), and a link that has moved more than 1 mm or 1 mrad from where its parent and joint place it is put back, with the correction fed back as a speed (SHAKE with RATTLE). A branch is as exact as a chain: a tree with 1000 kg ends that plain joints throw 42 m apart holds within 1 mm, and a hinge limit holds to 1e-7 rad where plain joints overshoot by a fifth. Contacts on a link share their impulse through the joints as an articulated body would. A tree has no size of its own (it uses the scratch rows of its joints, which grow with the world), a body is in one tree, and a removed joint or body dissolves its tree (`multibody.remove()` frees it on purpose).

A multibody reads where one link would be with `forwardKinematics(body, coordinates?)`, a point's Jacobian with `bodyJacobian(body, point?)`, the joints to a body with `kinematicBranch(body)`, and moves its coordinates by `applyDisplacements(deltas)`; a `kinematicPosition` body in `links` is a kinematic link that `setCoordinates` drives, `coupleDofs(physics, multibody, linkA, linkB, {ratio})` holds one link's coordinate (a hinge's angle or a slider's offset, at any depth) plus `ratio` times another's, on a row of the two links and their parents, and `inverseKinematics` takes `constrain: {position, rotation}` masks for the world axes that count, and keeps every hinge and slider inside its limits and a ball joint (a generic joint with `coupled: ['angY', 'angZ']`) inside its swing cone and its twist range. It reads its tree with `numLinks`, `attachedBodies()`, `linkIndex(body)`, `bodyAt(index)` and `jointBetween(a, b)`, and `multibody.selfContacts = false` makes no two bodies of the tree touch (the default, true, leaves each joint's own `contactsEnabled` to decide for the pair it holds).

Two kinds of joint can be solved inside the tree's own direct solve instead of the joint passes:
- `multibody.setImplicitMotors(link)` puts the motors of a link's joint there as implicit springs and dampers: force
  model, no `maxForce`, no limit on their axis. Each is stepped by backward Euler with every other link's, so a long, stiff
  chain of motor springs stays stable. A joint at a time, the joint passes let a 32-link chain of 7.7 N m² run away.
- `multibody.pinJoint(joint, true, give?)` holds a joint from a tree body to a body outside the tree as a stiff spring
  between its anchors. The outside body gets the pull back. `give` lets the pin stretch along its link as a spring, the
  half link at a rod's pinned end.

Rods are built on both (`@margoengine/physics/rod`).

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

A joint's armature is the rotor of a motor and its gearbox as the joint feels it (the rotor's inertia times the gear ratio squared, MuJoCo's `armature`): `joint.setArmature(inertia, dof?)` puts it on a hinge or slider's axis, on all three turns of a ball joint, or on one named axis, in kg m² for a turn and kg for a slide (default 0). In a multibody it adds to its coordinate's diagonal of `massMatrix()`, so gravity, torques, contacts and impulses all move that joint as if it were that much heavier; `forwardDynamics` and `inverseDynamics` count it. `multibody.augmentedMassMatrix(h)` adds what an implicit step of `h` seconds adds for each force motor, `h * (c + h * k)` for its damping and stiffness (pass `physics.fixedTimestep / physics.kernel.substeps`, the length the kernel takes motors over), `inverseMassMatrix(h?)` inverts the plain or augmented matrix, and `dofInverseInertia(h?)` is its diagonal, each coordinate's inverse inertia with the other joints free.

```ts
import {Physics} from 'margoengine/physics';

await Physics.load();
const physics = new Physics(null, {gravity: [0, 0, 0]});
const pivot = physics.addBody(null, {type: 'fixed', colliders: []});
const wheel = physics.addBody(null, {colliders: {shape: 'cylinder', radius: 0.3, halfHeight: 0.05, mass: 2}});
const drive = physics.addMultibody(pivot, [{body: wheel, joint: {type: 'revolute', axis: [0, 1, 0]}}]);
drive.links[0].joint.setArmature(0.09); // the motor's rotor, as heavy as the wheel itself
wheel.addTorque([0, 1.8, 0]); // held until resetTorques()
for (let i = 0; i < 60; i++) physics.step();
console.log(drive.velocities()[0].toFixed(2)); // '10.00': 1.8 N m over 0.09 + 0.09 kg m² for 1 s
console.log(drive.dofInverseInertia()[0].toFixed(2)); // '5.56'
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
| Kinematic position-based bodies on a smooth path: a target with the velocity and spin to reach it with, the body moving through the step on the cubic Hermite path of its pose, target and end speeds, so what rides on it feels its acceleration through the step (beyond Rapier, whose kinematic bodies move at one speed a step) | `setNextVelocity` | full | `kernel/tests/solver.rs`, `deck-props.test.js` |
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
| Joint armature, augmented mass and each coordinate's inverse inertia | `setArmature`, `augmentedMassMatrix`, `inverseMassMatrix`, `dofInverseInertia` | full | `multibody-armature.test.js` |
| Multibody links and lookups, self contacts on and off | `root`, `links`, `numLinks`, `attachedBodies`, `linkIndex`, `bodyAt`, `jointBetween`, `selfContacts` | full | `next-multibody-api.test.js` |
| Limits on two or three turning axes of one generic joint | `limits` on `angX`, `angY`, `angZ` | full | `next-joint-limits.test.js` |
| Coupled axes of a generic joint, softness of a joint's locks, joint damping and friction | `coupled`, `setSoftness`, `setDamping`, `setFriction`, motor `frequency` | full | `next-joint-coupled.test.js`, `next-joint-softness.test.js`, `next-multibody-kinematics.test.js` |
| Multibody forward kinematics of one link, Jacobian, branch, displacements, kinematic links, IK masks | `forwardKinematics`, `bodyJacobian`, `kinematicBranch`, `applyDisplacements`, `constrain` | full | `next-multibody-kinematics.test.js` |
| World settings: joint warm start share, world speed cap, static contact stiffness, wake all | `setSolver`, `wakeUpAll` | full | `next-world-settings.test.js` |
| Body reads: damping, dominance, gyroscopic switch, velocity at a point, predicted poses, energies, effective masses, copy | see Reading a body | full | `next-body-reads.test.js` |
| Cross-platform determinism | always on, there is no mode to switch: the kernel uses only + - * / sqrt, compares and integer operations, and `world.hash` is equal in Node, native code, Chromium and Firefox over 10,000 steps | full | `replay.test.js`, `kernel-step.test.js` |
| Snapshot and restore of a world | `world.snapshot()`, `world.restore()` | full | `kernel-solver.test.js`, `next-joints.test.js`, `next-parameters.test.js` |
| PID and PD controllers | `PidController`, `PdController`, `pdErrors` | full | `next-pid.test.js` |
| Debug-render data: colliders, joints, contacts, boxes | `debugRender` | full | `next-debug-render.test.js`, `next-debug-filter.test.js` |

### Features written over the kernel

| Capability (Rapier 3D) | `margoengine/physics` | Status | Tests |
| --- | --- | --- | --- |
| Kinematic character controller: offset, up vector, autostep, maximum slope climb angle, minimum slope slide angle, snap to ground, sliding | `createCharacterController` and `move` | full | `next-character.test.js`; `minSlopeSlideAngle` too |
| Character controller: pushing dynamic bodies, character mass, the collisions of a move | `applyImpulsesToDynamicBodies`, `characterMass`, `controller.collisions` | full | `next-character.test.js` |
| Dynamic ray-cast vehicle controller: suspension, engine, brake, steering, wheel friction; a tuned arcade car and its debug lines | `Vehicle`, `Vehicle.car`, `vehicle.debugRender` | full | `next-vehicle.test.js`, `vehicle-car.test.js` |
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
  cell: [0, 0, 0],
  port: () => undefined,
  bodyRows: () => 0,
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

`RigidSolver` puts a `Physics` in a `PhysicsWorld` as the framework's rigid solver: `world.add(new RigidSolver(), {physics})`. Each of its steps is the Physics's own `step()`, so its bodies, colliders, joints, queries, events and attachments work as before and a world steps it to the same bits as calling `step()` alone. It owns four fields:
- `bodies`, a body set of `BODY_WORDS` (25) f32 per kernel body row, published at each coupling tick: the origin's position (0-2), the rotation (3-6), the centre of mass (7-9), the linear (10-12) and angular (13-15) velocity, the inverse mass (16), the inverse inertia in world axes as its six distinct entries xx, xy, xz, yy, yz, zz (17-22), 1 for a moving body (23), and the substeps its last step took (24; the world's `substeps` times 2^k for its island's level, 0 for a body that does not move). A force held through a step of s substeps moves a body by (v + F dt (s + 1) / (2 s m)) dt, so a solver that holds a load from a body's pose takes it (s - 1) / (2 s) of the step on, where the load neither feeds the motion nor drains it.
- `bodyImpulses`, which other solvers accumulate into: `IMPULSE_WORDS` (6) numbers per body row, a linear impulse in N s and an angular impulse about the body's centre of mass in N m s, world axes. A load at a point p is the pair (J, (p - c) x J) with c the centre of mass from `bodies`: pairs add, so the world sums the contributions by contributor and then by element, and the rigid solver applies the sum at the start of its next step. (A point and an impulse would not add.)
- `bodyMobility`, available at setup and at the same tick and cell as `bodies`. The `BODY_MOBILITY_WORDS` (9) f32 per body row give three linear inverse masses X, Y, Z and the six distinct angular inverse inertia entries XX, XY, XZ, YY, YZ, ZZ in world axes. Multiply these by a linear or angular impulse to get the initial velocity change with axis locks. Fixed and kinematic rows are zero. The `bodies` layout still holds the unprojected mass properties.
- `bodyForces`, which other solvers accumulate into the same way: `FORCE_WORDS` (6) numbers per body row, a force in N and a torque about the centre of mass in N m, world axes. The rigid solver adds the sum to the bodies' forces for its next step only and takes off exactly what they took after it, so a push held over a step (a cloth holding a box up, a hull's load) acts through the step and leaves nothing behind.

Migration: a world steps at the framework's rates, so the Physics's `fixedTimestep` must be one of them (1/60, 1/120, 1/240 ... 1/7680 s); any other is refused with a `RangeError` that names the nearest two (`rateLevelOf(step)`). The kernel's state is the words its own hash covers, named by column and row capacity (`positionX[1024]`), with the scratch columns it carries from one step into the next as extra state, in the kernel's own memory until the framework's solvers share one. The Physics's `stepCount` is extra state too (one f64 region, `stepCount`), so a seek by `restoreSnapshot` rewinds the clock that winds, sails and `Physics.advance` read as `stepCount * fixedTimestep`; the Physics takes the restored count at the world's next step. A snapshot restored into a world built with other capacities or another column table is refused before anything is written. Use `new RigidSolver('rigid', {publishMobility: false})` to restore the same rigid world with checkpoints captured before `bodyMobility` was introduced. Recreate older frame-zero checkpoints from their scene if the old registry had yet to allocate an accumulator sum.

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

`CloudSolver` (ATMO-03) evolves moist air and warm rain over flat ground. Configure the box with `cells`
(default `[48, 24, 48]`), `cellSize` (200 m), `centre` (`[0, 0]` in X and Z) and `ground` (0 m).
The reference atmosphere uses `altitude` (0 m), `seaLevelTemperature` (298.15 K), `humidity` (0.75 at the ground)
and `humidityTop` (0.3 at the top). Set `surfaceHeat` (250 W/m²), `surfaceLatent` (150 W/m²), `patchiness` (0.6),
`thermalPeriod` (600 s), `vorticity` (0.2) and optional initial `bubbles` to author the forcing.
`interval` defaults to 2 s of atmospheric time. `timeScale` defaults to one atmospheric second per world second.
Pass a `wind` for horizontal transport. Its velocity is sampled in the Wind's origin cell using `worldCellSize`
(default 4096 m).

Use `new CloudSolver()` for the scalar pressure stencil, or `await CloudSolver.load()` for the Rust SIMD stencil.
With `threads: 4` and shared world memory, three helpers apply the stencil in parallel while the caller reduces
its sums in a fixed order. In a browser run the threaded world inside an isolated Worker. Dispose the solver when
finished. `projectionDiagnostics` gives the physical divergence before and after projection and the checked
residual. `workCounts()` reports actual native cells and SIMD-paired rows in the last accepted world tick.

The `cloudWater` registry port and `cloudWater()` use kg/kg, with X fastest, then Y, then Z. Use
`CloudDensityVolume` from `@margoengine/environment/density-volume` to draw the accepted condensate.
`sample()` returns air temperature, water phases and velocity in local metres. `rainSource()` feeds the
Weather precipitation field in mm/h. `windWith(base)` adds convective flow in the base wind's origin frame.
The upwind boundary uses fresh environment air, so the semi-Lagrangian scalar transport does not conserve total
water. Ice microphysics, terrain lift and anelastic flow remain open. Snapshots made before the accepted mean
wind and diagnostics regions were added need to be re-recorded.

```ts
import {CloudSolver} from 'margoengine/physics/clouds';
import {PhysicsWorld} from 'margoengine/physics/world';

using clouds = await CloudSolver.load();
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
console.log(clouds.projectionDiagnostics.divergenceAfter < 1e-9); // true: checked divergence (s^-1)
```

### Sea waves: a spectral wave model (`@margoengine/physics/waves`)

`WaveSolver` is the physics framework's sea waves (SEA-01): a third-generation spectral wave model, the energy balance of WAM as SWAN states it, on a grid of the water. Wind seas grow with fetch and duration, swell runs in from the open sea at its group velocity and decays slowly, and waves feel the bottom and break where the water is shallow. The physics: by default the ST4 wind input and dissipation of Ardhuin et al. (2010), as WAVEWATCH III states them (Janssen's input with the waves' own stress feeding back on the sea's roughness, swell damped by the air, breaking from the spectrum's saturation), with Cavaleri and Malanotte-Rizzoli's linear growth, the discrete interaction approximation of the quadruplets, JONSWAP bottom friction, Battjes and Janssen depth breaking, and the Hersbach and Janssen action limiter. `physics: 'wam3'` swaps in WAM Cycle 3's Komen input and whitecapping. Waves travel by the third-order ULTIMATE QUICKEST scheme, so a wind sea grows along its fetch as measured, without the smearing of a first-order scheme. Its settings:

- the grid: `cells`, default 32 by 32, of `cellSize` metres, default 1000, about `centre`;
- the water: `depth` (a number or a function of (x, z), 0 or less for land) or a terrain `bed` under `waterLevel`, and `density` (1025 for the sea, `FRESH_WATER_DENSITY` 1000 for a lake);
- the `wind` over it, any framework `Wind`, sampled 10 m above the water. Set `originCellSize` to the scene's cell size if it differs from 4096 m;
- the spectrum: `frequencies` (default 0.04 to 1 Hz in 34 steps) and `directions` (default 24);
- the sea: a JONSWAP `swell` coming in over the open edges, a `start` sea, and `periodic` edges for a sea that goes on the same way;
- time: `interval` (the sea's own step, default 60 s), `timeScale`, and `warmUp`, seconds of sea run before the shot so the sea is already up;
- `physics`: `'st4'` (default) or `'wam3'`.

**How well it grows.** Every ST4 constant is the WAVEWATCH III manual's TEST471 set except the sheltering of the short waves `s_u`: the manual gives 0.3 for TEST471 today and 1 for TEST471 before 2012 and for TEST500. It was calibrated the way the wave-modelling community tests fetch growth (Liu et al. 2019): against Kahma and Calkoen's stable fetch law in friction-velocity scaling, e* = g^2 E / u*^4 = 2.1e-3 chi*^0.79 with chi* = g x / u*^2, at 10 and 20 m/s, on a grid that resolves the coast. 1 fits best (rms of ln(e* / law) 0.108 at 10 m/s and 0.046 at 20 m/s; 0.125 and 0.099 at 0.3); the roughness cap makes no difference and stays TEST471's. At 30 m/s the same fitted law gives rms 0.038 and a slope of chi*^0.76. That comparison checks consistency across wind speeds. The independent Lake George comparison holds gauge measurements out of the model inputs (see the limits). In U10 scaling at 10 m/s the height is within 14 percent of Hwang's fetch law and JONSWAP's over chi = g x / U^2 of 1,000 to 10,000; with unlimited fetch, run to g t / U10 = 2.5e5, the developed sea is 0.221 U10^2 / g at 10 m/s and 0.281 at 20 m/s, against Alves, Banner and Young's 0.254 (band 0.233 to 0.272), its peak within 6 percent of their 0.123 g / U10. Pierson and Moskowitz's often-quoted 0.21 is in the wind at 19.5 m (0.241 in U10). ST4's input scales with u*, so the developed sea rises with the wind more than the data show (a ratio of 1.27 from 10 to 20 m/s against their 1.02), as Rogers et al. (2012) note of this family, and it keeps growing slowly rather than stopping (Ardhuin et al. 2010). **Resolve the coast:** fetch growth converges with the grid, and a coarse grid near a shore spreads the young waves' fast growth over too long a fetch. Take cells of g dx / U^2 of about 60 or less over the first part of the fetch; at 250 the law flattens to chi^0.63 and short fetches run 40 percent high in energy at 20 m/s. Keep `interval` at 120 s or less: at 300 s the action limiter starts to shape the growth. It costs about 4.6 ms a cell-step in TypeScript, five times WAM Cycle 3. `waves.frictionVelocity(x, z)` gives the wind's u* over the water there, from the waves' own roughness with ST4 (a young sea drags harder): the stress on the sea is rho_a u*^2.

When a wind sample or numerical update fails, the previous spectrum, friction and wave clock stay accepted. The error identifies what to fix. Load native spatial transport with `WaveSolver.load(id?, {threads, signal})`. It uses the same flux formula and preserves the scalar bits. One participant is the default. Two or four participants run in Node or an isolated browser worker. Dispose the loaded solver after the world finishes. `readNativeWork()` reports the last accepted tick's directional sweeps, face fluxes and cell updates.

It publishes the spectrum E(f, theta) of every cell as the registry field `waveSpectrum`. `waves.field` is the framework's `WaveSpectrumField`, which the sea surface synthesises its waves from. `significantHeight(x, z)` and `peakPeriod(x, z)` summarise a place. `wavenumber`, `groupVelocity`, `jonswap`, `significantHeight` and `peakFrequency` work on any spectrum.

```ts
import {FRESH_WATER_DENSITY, WaveSolver} from 'margoengine/physics/waves';
import {PhysicsWorld} from 'margoengine/physics/world';
import {BoundaryLayerWind} from 'margoengine/weather/boundary-layer';

// A gale of 18 m/s across a deep lake, from its western shore, ten hours in.
// The wind and depth are uniform across the lake, so one periodic row represents the same fetch.
const wind = new BoundaryLayerWind({speed: 18, turbulence: false});
using waves = await WaveSolver.load();
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
long behind a hull at speed U, with transverse and diverging crests. The apparent crest angle depends on the forcing
footprint and measurement window. A border of `sponge` cells absorbs what reaches the edge. Its height and potential are
world state (snapshot, restore, hash). `sample(x, z)` gives the wake's height, slope and surface velocity; pass the solver
to `SpectralSea` as one of its `patches` and the sea's `sample`, `elevation` and `pressure` carry it, so a hull floats on
its own wake and on the ships around it.

The solver publishes `wakeHeight` at each step as a layout-`WAKE_LAYOUT` f64 field in metres.
`grid` gives its dimensions, spacing and first corner. Cells run along X first, then Z.
Invalid wake parameters and sources report a `MargoError` with code `state` and a message that names the fix.

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

Made with `waterBelow: true`, the wake also keeps the water's velocity below its surface: at each step, the gradient of
its potential at a few depths, each mode decaying as cosh(k (D - d)) / cosh(k D). `velocityAt(x, y, z)` reads it, and a
`SpectralSea` with the wake among its `patches` adds it to `water.sample`, so the water under a wake moves with it. A
liquid box held to that sea (`FlipSolver`) takes the wake's waves in at its sides.

```ts
import {WakeSolver} from 'margoengine/physics/sea';
import {PhysicsWorld} from 'margoengine/physics/world';

const wake = new WakeSolver();
new PhysicsWorld({rate: {num: 60, den: 1}}).add(wake, {
  cells: [64, 64],
  cellSize: 0.25,
  waterBelow: true,
  initial: (x) => [0, 0.1 * Math.cos((Math.PI / 4) * x)], // a wave 8 m long: its potential, 0.1 m^2/s
});
const k = Math.PI / 4;
const [u] = wake.velocityAt(1, -0.5, 0); // the water half a metre down
console.log(Math.abs(u + 0.1 * k * Math.sin(k) * Math.exp(-0.5 * k)) < 0.002); // true: -A k sin(k x) e^(k y)
```

The optional `current` shifts propagation by the uniform horizontal flow in m/s. The wake samples
wave velocity relative to that background, so a `SpectralSea` can still own the mean flow. Set
`surfaceTension` in N/m for small waves and `kinematicViscosity` in m²/s for leading-order surface
decay. Omit all three for the original gravity-only model.

```ts
import { WakeSolver } from 'margoengine/physics/sea';
import { PhysicsWorld } from 'margoengine/physics/world';

const wake = new WakeSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(wake, {
  cells: [64, 32],
  cellSize: 0.002,
  depth: 0.04,
  density: 998,
  sponge: 0,
  current: [0.08, 0],
  surfaceTension: 0.073,
  kinematicViscosity: 1e-6,
  sources: (t) => t < 1 / 60 ? [{ x: 0, z: 0, radius: 0.005, pressure: 20, volume: 0 }] : [],
});
world.advance(12);
console.log(Number.isFinite(wake.sample(0.02, 0).height));
```

For the native SIMD transform, use `await WakeSolver.load({ signal })`. It loads a separate Wasm
asset and keeps the same grid, ports and snapshot bits as `new WakeSolver()`. The loaded plan's
memory is private, so both shared and unshared worlds can use it. `fftWork()` reports the
transforms and bytes copied per step.

For measured or authored drops, `wakeRainSource` deposits the drop's volume and downward
impulse in one wake step. When ATMO-04 supplies the local precipitation, pass recorded
contact positions and times to `wakeRainSources` to derive the equivalent drop from its
rain mass and energy flux. Both use metres and seconds. Give the impact a complete
footprint inside the grid and use surface tension to resolve the propagating capillary rings.

```ts
import { WakeSolver, wakeRainSource } from 'margoengine/physics/sea';
import { PhysicsWorld } from 'margoengine/physics/world';

const wake = await WakeSolver.load();
const grid = { cells: [64, 64] as const, cellSize: 0.002, origin: [-0.064, -0.064] as const };
const drop = { x: 0, z: 0, diameter: 0.002, fallSpeed: 6.5 };
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(wake, {
  cells: grid.cells,
  cellSize: grid.cellSize,
  sponge: 0,
  surfaceTension: 0.073,
  kinematicViscosity: 1e-6,
  sources: (t) => t < 1 / 60 ? [wakeRainSource(drop, grid, 1 / 60)] : [],
});
world.advance(4);
console.log(wake.fftWork().backend); // wasm-simd
```

Enable a diagnostic crest field with `WakeSolver.load({ breaking: {} })` or the constructor's
fourth argument. Pass `wake.breakingField` to `new FoamSolver('foam', wake.breakingField)` to
feed those crests into local active foam and spray. Both solvers must use the same world cell.
The layout-1 header holds the written row count, total detected count and wake cell width.
Increase the optional `capacity` if the written count falls short. The default is up to 4096
rows, bounded by the grid's cell count. The crest field estimates onset in resolved linear
waves and preserves the wave state.

```ts
import { FoamSolver } from 'margoengine/physics/foam';
import { WakeSolver } from 'margoengine/physics/sea';
import { PhysicsWorld } from 'margoengine/physics/world';

const wake = await WakeSolver.load({ breaking: {} });
const foam = new FoamSolver('foam', wake.breakingField);
const spectrum = {
  frequencies: Float64Array.of(0.25, 0.5),
  directions: Float64Array.of(0, Math.PI),
  energy: new Float64Array(4),
  depth: 4,
  density: 1025,
};
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
  .add(wake, { depth: 4 })
  .add(foam, { waves: { cell: [0, 0, 0], sample: () => spectrum } });
world.advance(1);
console.log(foam.meanCoverage()); // 0 on still water
```

The finite wake can exclude a hull's mean wetted cells and prescribe a small motion through
the normal velocity on those faces. Its `hullExchange()` returns the accepted linear and
angular pressure impulse, cumulative joules and displaced cubic metres. Use the midpoint
step, and for an in-progress world set `hull.startTime` to `world.time` before adding
the prescribed hull. A fixed hull omits `velocity`. The mask represents the mean pose over
the run, so this setup is for fixed hulls and small motion about that pose.
Use `bakeWakeHullMask` with a closed, consistently wound mesh. Imported meshes and code-built hulls
use the same indexed vertex input. Pass an optional column-major hull-to-wake affine matrix for a
mesh in local coordinates. The baker closes solid cell centers at the grid's actual layer depths.

```ts
import { FiniteQuayWake } from 'margoengine/physics/loads';
import { bakeWakeHullMask } from 'margoengine/physics/sea';
import { PhysicsWorld } from 'margoengine/physics/world';

const grid = { cells: [16, 8] as const, cellSize: 0.25, depths: [0, 0.5, 1] };
const hull = {
  vertices: [2, -0.75, 1, 2, 0.25, 0, 3, 0.25, 1, 2, 0.25, 2],
  indices: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2],
};
const wake = new FiniteQuayWake();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(wake, {
  ...grid,
  pressureAtDepth: true,
  hull: {
    mask: bakeWakeHullMask(hull, grid),
    centre: [2.125, -0.125, 1],
    velocity: (t) => [t < 0.1 ? 0.01 : 0, 0, 0, 0, 0, 0],
  },
});
world.advance(12);
console.log(wake.hullExchange()?.joules);
```

### A hull on the sea (`@margoengine/physics/seakeeping`)

`HullSolver` is the water's load on rigid hulls (SEA-08), for the physics framework's rigid solver.
Keep the sea in the hull solver's origin cell. If the rigid solver uses a different cell in a world with a nondefault
cell size, pass that size in metres as `originCellSize` (default 4096). If a sea query fails or a load would overflow
the rigid body's force columns, the step throws a [coded error](https://margoengine.com/errors#ship-seakeeping) and
leaves the accepted loads, wake sources and histories intact.
- **Each step:** it reads where each hull's body is from the `bodies` port, and integrates the water's pressure over the wetted part of the hull's surface, taken where the held load neither feeds the motion nor drains it (see **The load each step**). It then holds the body with that force, and its moment about the centre of mass, over the rigid step through `bodyForces`.
- **The hull** is a closed triangle mesh in the body's frame, wound outward. Each triangle is cut where the sea's surface crosses it (the linear cut, then two secant steps on the surface). The wet pieces are integrated by Dunavant's six-point rule, which is exact for the hydrostatic force and moment.
- **The sea** is the framework's sea surface, `SpectralSea` from `@margoengine/physics/sea` (the wave solver's spectrum as a sum of waves; measured: in its long swell a box rides up and down within 0.04 percent of the frequency-domain answer), made in the hull solver's origin cell (another cell is refused, naming the fix); or anything with `elevation(x, z, t)`, and optionally `pressure(x, y, z, t)`: the hydrostatic pressure plus the waves' dynamic pressure, stretched to 0 at the surface (Wheeler). Without it, the water is still to its local surface, rho g (eta - y). The pressure over the instantaneous wetted surface is the nonlinear Froude-Krylov load. `density` is the sea's, default sea water.
- **`wettedLoads(mesh, pose, sea, t, about)`** gives the same force, moment and wetted area for one hull at one instant.

Use `bakeHullSlamming(mesh, {density, stations, levels, threads, signal})` to prepare the same Wagner section tables in
Rust Wasm. Defaults are 1025 kg/m³, 24 stations, 48 height levels and one participant. With `threads: 2` or `4`,
independent stations run across actual native workers and the caller. Keep the body-frame mesh, density and station
count the same when assigning the result to `Hull.slammingTable`. Use its `work` receipt to see how the quadrature was split.
For green water, `hull.deckSurface(row)` copies the accepted X-fast deck height and water depth in body coordinates.
Height is NaN off the deck. It returns undefined before a live deck update or when green water is disabled.

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
  - when released from 15 degrees about the experiment’s roll-only hinge, Jung, Chang and Jo’s box gives a decay coefficient of 0.351 against 0.333 measured (5.3 percent high), and a period of 0.893 s against 0.930 s (3.9 percent short). No outcome sets a model parameter.
- **The water a hull carries:** its added mass at infinite frequency, from its sections under the waterline it floats at each step (strip theory). Each section is mapped to its Lewis form, and its heave added mass is integrated to the hull's heave and pitch; its sway and roll added mass at infinite frequency come from the radiation solution below (the free surface makes it smaller than the rigid-lid value `swayAddedMassRigidLid`, which is the zero-frequency limit). The solver holds M (M + A)^-1 (F + W + E) - W - E, so the body moves as hull and water together, stable even when the water outweighs a light hull. E is every other load on the body (a tow, the wind, a sail, a contact), seen from its last two steps. `addedMass: false` leaves it out; where a ship solver's manoeuvring model claims a hull (`manoeuvringClaims`), the surge, sway and yaw rows of the added mass and of the radiation below are the ship's and left out; `stations` sets the sections (default 24); `gravity` must be the rigid world's. `hullSections`, `lewisForm` and `addedMassInfinite` are exported to inspect it.
- **The waves a hull makes:** its heave, pitch, sway, roll and yaw damping and their couplings, with memory (Cummins 1962).
  - Each section's damping at each frequency comes from Ursell-Tasai's multipole solution on its Lewis form: `heaveSection` in heave, `lateralSection` in sway and roll about the centre of mass (and their coupling). The damping is computed twice, once from the pressure on the hull and once from the energy of the waves it sends out, and the two agree.
  - The damping is integrated along the hull at its still-water draft (`hullMemory`), turned into the radiation kernel K(t), and convolved with the hull's motion over the last `memory` seconds (default 20).
  - A hull let go settles, and a hull driven at a frequency heaves as the frequency-domain equation of motion says. `radiation: false` leaves it out.
- **Near-steady forward course:** set `course: {}` on a hull to use its horizontal forward velocity in the Salvesen–Tuck–Faltinsen heave and pitch terms. With current or a prescribed tow, pass `course.speed` in water-relative m/s. Pass `course.trim` in bow-up radians if the mean attitude is inclined (default zero). The existing radiation and added-mass options must be on. A course speed that would make the strip model lose static pitch restoring is rejected. With `SpectralSea`, each incident component uses the encounter-scaled orbital velocity for both section damping and the longitudinal change in added mass. The live subsurface flow still feeds the relative-motion calculation.
- **Roll's viscous damping:** the eddies a rolling hull sheds at its bilges and the friction of its skin, which potential flow leaves out and which damp a real hull's roll most near its resonance (Ikeda's component method, ITTC 7.5-02-07-04.5). Each section's eddy coefficient (`eddyRollCoefficient`) and skin friction (`frictionGirth`, Kato's laminar law at the hull's natural roll frequency) are integrated along the hull about its centre of mass, and the moment -(eddy |p| + friction) p, p the roll rate, is taken implicitly in the damping, so a light hull stays stable. `rollDamping: false` leaves it out; `viscosity` is the water's kinematic viscosity (default `SEA_VISCOSITY`, 1.19e-6 m^2/s, sea water at 15 degrees C; fresh water 1.14e-6). With `Hull.course` and positive water-relative forward speed, the ITTC bare-hull model adds lift, increases skin friction and attenuates the eddy component. It uses the small-amplitude natural roll frequency. Forward-speed roll radiation and skegs are separate effects.
- **The load each step** is taken where a load held through the rigid step neither feeds the motion nor drains it: (s - 1) / (2 s) of the step on, s the substeps the `bodies` port gives (7/16 at 8), the pose carried there by the body's velocity and spin. Taken at the middle, a hull lost about pi w dt / (2 s) of its amplitude a cycle; taken where the step starts, it gained energy. The radiation force, convolved up to the step's start, is carried to the same point along its last two values.
- **The waves a hull turns:** their diffraction, by strip theory's relative motion principle (Journee and Massie eqs. 8.19 and 8.45-8.47). Each section takes its added mass times the water's acceleration and its radiation memory convolved with the water's velocity, as it takes them for its own motion, at the depths that stand for its motion: its mean draft in heave and its centroid's depth in sway and roll. The Froude-Krylov part is the pressure over the wetted surface. It needs a sea that gives the water's motion (a `SeaSurface`'s `water`, as `SpectralSea`'s does); `diffraction: false` leaves it out. Measured: in head seas a box heaves within 1 percent of strip theory's frequency-domain answer (82 to 267 percent off without the diffraction); held in beam seas, its sway force and roll moment are within 1.5 percent.
- **The waves' drift:** the mean and slowly varying push of the waves a hull sends back. Each section's far-field drift in beam waves is the momentum the waves carry, 1/2 rho g a^2 |R|^2 per metre (Maruo; a wall sending everything back takes 1/2 rho g a^2), R the wave it sends back while it moves as the hull does (`scatterSection`, the two-dimensional scattering derived from the radiation solution). The solver applies it less the part its Froude-Krylov pressure over the moving wetted surface already gives, across the hull, over the sea's waves by Newman's approximation (the mean and the slow beat of wave groups). It needs a sea that gives its waves (`SpectralSea`'s `waveComponents`); `drift: false` leaves it out. Measured: moored in beam waves, a box's mean offset holds the far-field drift within 3 percent of the wall's force, and in short waves the wall's itself.
- **Green water:** the sea coming over the deck, after Zhang and Reed (2024): shallow water on each hull's deck (`deckOf`, the mesh's upward-facing top above its still waterline, on a grid of `deckCells`, default [32, 12]) in the deck's moving frame (`stepDeck`: Rusanov's flux with Audusse's hydrostatic reconstruction, so a lake on a sloped deck stays still and cells dry). Where the sea stands above a deck edge it comes aboard as a dam breaks (Ritter's critical flow at the edge), and where it does not the deck water runs off at the brink. The deck water's weight, rho G h with G the deck's effective gravity, loads the hull, and the deck's own faces then take no Froude-Krylov pressure, so the water over them is counted once. What comes aboard is published in the `deckInflow` port for a liquid solver on the deck; where one owns a hull's on-deck load (`deckClaims` 1), the hull solver leaves its own out. `greenWater: false` leaves it out. Measured: a dam on the deck breaks within 1.1 percent of Ritter's solution, the sea comes over a dry edge at Ritter's flux (to 1e-4), and a box held with its deck under water takes the whole submerged box's buoyancy (to 1e-4).
- **Slamming:** a section coming down into the water takes the momentum of the water it sets moving, (dm/dh) V^2 a metre (von Karman 1929), m the added mass of its wetted width with the water's pile-up (Wagner 1932: the wetted half-breadth c solves the mean of the section's height over c sin(theta) equal to its depth), V its speed into the water; past a chine or knuckle the flow leaves the hull and the impact ends. Each station's table comes from the mesh's sections (`slamStations`, `slamSlope`). `slamming: false` leaves it out. Measured: a 30 degree wedge entering at a steady speed takes Wagner's force within 0.02 percent until its chine is wet.
- **Flooding:** closed, outward-wound compartment meshes are in the body's frame. Their free volume defaults to 95% of the mesh volume. Each holds water, air and optional cargo. The free surface stays perpendicular to gravity as the hull moves. The solver applies the floodwater's weight at its centre and publishes external air and cargo through `hullBreaches` for the foam and tracer solvers.
- **Openings:** give their centre, normal, width and height in body-local metres. Water flows according to the difference in air pressure and hydrostatic head. A dry compartment contributes air pressure with zero water head. The default discharge coefficient is 0.611 for a sharp-edged opening. Air may leave by a vent or bubble through a submerged breach. Set `opens`, `closes` or `collapse` for time or pressure control.
- **Accepted flood state:** `hull.floodedCompartments(row)` copies the latest water volume (m³), air mass and cargo mass (kg) in configuration order, or returns undefined before attachment or for a hull without compartments. For standalone `Flooding`, invalid queries reject before changing the caller's state or the last result. `flooding.convergenceWarning` reports a [coded diagnostic](https://margoengine.com/errors#hull-flooding) if a finite step hits the 200-sweep iteration limit. Check the flow and mass balance when that occurs.
- **Optional volume kernel:** `loadFloodVolumeKernel({threads, signal})` lazily loads a disposable Wasm kernel. Assign it to `HullParams.floodVolumeKernel` or pass it as the third argument to `new Flooding`. It clips each compartment at its 47 non-empty levels after an attitude change. The default is one participant. Multiple participants use real workers in a runtime with shared Wasm memory. Heights reuse the existing table at the same attitude, including vertical movement. Keep the kernel open while the world uses it.
- **Flooding evidence:** analytical checks cover Torricelli, the weir law, trapped air and the lost-buoyancy equilibrium. The cutaway and the independent measured shortfall are described in the [flooding limits](../../docs/limits.md#progressive-flooding-evidence-and-limits-sea-10).
- **Form drag:** each wet piece facing the way the hull moves through the water takes the stagnation pressure 1/2 rho C (v . n)^2 (Newton's impact law of drag; `dragCoefficient` C, default 1.05, Hoerner's cube face-on), v its velocity relative to the water at the centre of mass, the roll's part left to the roll damping where that is on. It is taken in the share the hull has gone under past the displacement it floats at (0 floating, 1 with all of it under): a floating hull's resistance is its surface models' (the waves it makes, its roll's eddies, a manoeuvring model's resistance). It sets the speed a hull that has lost its buoyancy sinks at and how it turns going down. `drag: false` leaves it out. Measured: a box falling flat under the sea comes to the speed where its drag holds its weight less its buoyancy (to 0.1 percent).
- **Not yet:** deck structures and bulwarks in the green water, sloshing of the floodwater.

```ts
import {Physics} from 'margoengine/physics';
import {bakeHullSlamming, HullSolver} from 'margoengine/physics/seakeeping';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
using physics = new Physics(null, {fixedTimestep: 1 / 60});
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
const slammingTable = await bakeHullSlamming(mesh, {threads: 2});
const hull = new HullSolver();
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(hull, {hulls: [{row: box.row, mesh, slammingTable}], sea: {elevation: () => 0}})
  .couple(['hull', 'rigid'], 'staggered');
world.advance(60);
console.log(Math.abs(box.position[1] - (D / 2 - T)) < 1e-3); // true: it floats at its draft
console.log(hull.deckSurface(box.row)?.depth.every((h) => h === 0)); // true: the deck stays dry
```

A barge strikes a fixed quay. Its wing tank opens when the crush patch loses its seal, floods while
air leaves by a vent, and makes the barge list. Pass `CrushSolver.damageField` as the third argument
to `HullSolver` and use the zero-based `crushPatch` index on the opening. That opening stays shut by
default until its seal loss reaches `1`. Its configured rectangle then opens permanently.

```ts
import {Physics} from 'margoengine/physics';
import {CrushSolver} from 'margoengine/physics/crush';
import {HullSolver, loadFloodVolumeKernel} from 'margoengine/physics/seakeeping';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
/** A box from corner a to corner b, twelve triangles wound outward. */
const cuboid = (a: number[], b: number[]) => {
  const v: number[] = [];
  for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) v.push(x, y, z);
  return {vertices: v, indices: [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]};
};
using physics = new Physics(null, {fixedTimestep: 1 / 60});
using floodVolumeKernel = await loadFloodVolumeKernel();
// A 20 by 4 by 8 m barge floating at a 2 m draft.
const barge = physics.addBody(null, {
  linearVelocity: [0.5, 0, 0],
  colliders: {shape: 'box', halfExtents: [10, 2, 4], mass: 1025 * 20 * 8 * 2},
});
const hull = {
  row: barge.row,
  mesh: cuboid([-10, -2, -4], [10, 2, 4]),
  // A wing tank on the starboard side, the barge's full depth.
  compartments: [{mesh: cuboid([-5, -2, 2.5], [5, 2, 4])}],
  openings: [
    // A potential 2 by 0.5 m opening, and a vent in the tank's top.
    {from: 0, to: 'outside' as const, centre: [0, -1.5, 4] as const, normal: [0, 0, 1] as const, width: 2, height: 0.5, crushPatch: 0},
    {from: 0, to: 'outside' as const, centre: [0, 2, 3.25] as const, normal: [0, 1, 0] as const, width: 0.3, height: 0.3},
  ],
};
const crush = new CrushSolver();
const seakeeping = new HullSolver('hull', undefined, crush.damageField);
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(crush, {bodyCapacity: physics.kernel.capacity, patches: [{
    body: barge.row, anchor: [10, 0, 0], normal: [1, 0, 0], radius: 0.3,
    support: {point: [10.15, 0, 0]}, sealStroke: 0.04,
    material: {stiffness: 1e6, yieldForce: 1e5, stroke: 0.25},
  }]})
  .add(seakeeping, {hulls: [hull], floodVolumeKernel, sea: {elevation: () => 0}, greenWater: false})
  .couple(['rigid', crush.id, seakeeping.id], 'staggered');
for (let f = 1; f <= 60 * 60; f++) world.advance(f);
const heel = (2 * Math.asin(barge.rotation[0]) * 180) / Math.PI;
const tank = seakeeping.floodedCompartments(barge.row)?.[0];
if (crush.read(0).sealLoss !== 1 || heel < 13 || heel > 14.5 || !tank || tank.waterVolume <= 0) {
  throw new Error('Expected the damaged barge to flood and list');
}
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

#### Three-dimensional hull panels

`bakeHullPanels(mesh, options)` lazily loads a Rust Wasm solver and bakes coupled radiation and diffraction at the reference waterline. Give the returned table to `Hull.panels`. HullSolver uses its six-axis added mass and radiation kernels, and its heading-dependent diffraction with a `SpectralSea`. The hull's immersed pressure still supplies the incident-wave load. A table can be reused for identical hulls. Use a closed outward-wound mesh, 2 to 64 increasing angular frequencies in rad/s, and wetted edges at most one eighth of the shortest baked wavelength. Set `waterline` and `centre` in body coordinates. `depth`, `density` and `gravity` must match the sea and world. The default is deep water, seawater at 1025 kg/m³, gravity of 9.81 m/s², and 16 evenly spaced diffraction headings. Use `headings: 0` for radiation alone. Set `threads: 2` or `threads: 4` to bake independent frequencies in the caller and up to three workers. One participant is the default. An explicit thread count adds a `work` receipt to the table. An `AbortSignal` cancels the download and worker batch. The retained frequency order and computed coefficients are identical across participant counts.

```ts
import {Physics} from 'margoengine/physics';
import {bakeHullPanels, HullSolver} from 'margoengine/physics/seakeeping';
import {PhysicsWorld, RigidSolver, worldMemory} from 'margoengine/physics/world';

await Physics.load();
const mesh = {
  vertices: Float64Array.of(-0.5,-0.5,-0.5, 0.5,-0.5,-0.5, 0.5,0.5,-0.5, -0.5,0.5,-0.5,
    -0.5,-0.5,0.5, 0.5,-0.5,0.5, 0.5,0.5,0.5, -0.5,0.5,0.5),
  indices: Uint32Array.of(0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4,
    2,3,7, 2,7,6, 1,2,6, 1,6,5, 0,4,7, 0,7,3),
};
const panels = await bakeHullPanels(mesh, {frequencies: [0.6, 1.2, 1.8], depth: 3, headings: 0, threads: 2});
const world = new PhysicsWorld({rate: {num: 60, den: 1}, memory: worldMemory(false)});
using physics = new Physics(null, {fixedTimestep: 1 / 60, arena: world.arena});
const hull = physics.addBody(null, {
  position: [0, 0.01, 0],
  colliders: {shape: 'box', halfExtents: [0.5, 0.5, 0.5], mass: 512.5},
});
world.add(new RigidSolver(), {physics})
  .add(new HullSolver(), {
    hulls: [{row: hull.row, mesh, panels}], sea: {elevation: () => 0},
    greenWater: false, slamming: false, rollDamping: false,
  })
  .couple(['hull', 'rigid'], 'staggered');
world.advance(60);
console.log(panels.panelCount, hull.position[1]);
```

#### Ship hull on a steady course

Set a tow speed relative to the water and keep the body on that course with the rigid solver or the ship controller. With `course: {}` or an omitted `course.speed`, the hull projects its velocity relative to the sea surface sample’s mean current along the course. The hull still responds to heave and pitch loads. Set `course.lateralHeading` in radians from +X towards +Z to include the ordinary-strip sway, roll and yaw speed terms around a fixed heading. It is omitted by default. Use it for small motions of a slender hull with tapered ends. A manoeuvring solver still owns any sway and yaw rows it claims. Enable `surgeAddedMass` to carry three-dimensional water inertia along the hull axis in the high-encounter-frequency limit. It defaults to false. Use a closed solver mesh with at most 512 wetted triangles after clipping. `SpectralSea` supplies the reference bed depth. The option uses the same rigid force port as the other added masses. Add optional `bilgeKeels` for viscous roll damping. Each plate specifies a root midpoint in hull coordinates, a `[dy, dz]` offset from root to tip and a fore–aft length, all in metres. The hull’s natural small-amplitude roll frequency is used unless a prescribed `rollFrequency` is given in rad/s. Omit the list for a bare hull. The wet part of each plate contributes normal drag and forward lift. Seat the root midpoint on the hull mesh to include the separate hull-pressure moment. It follows the wet girth on that side of the hull. The wet plate also adds inertia along its normal when `addedMass` is enabled, its default. The drag coefficient uses the low-excursion extension of the ITTC model so that a light roll in calm water does not acquire the extrapolated large drag of the original fit.

Set `shortWaveResistance: true` to carry the mean axial load from reflected short waves on a surface-piercing hull. It uses `SpectralSea.waveComponents`, the reference waterline from the hull mesh, draft, and the water-relative course. The option defaults to false and can be enabled alongside the separate beam-wave drift model.

```ts
import {Physics} from 'margoengine/physics';
import {HullSolver, SEA_WATER} from 'margoengine/physics/seakeeping';
import {SpectralSea} from 'margoengine/physics/sea';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
using physics = new Physics(null, {fixedTimestep: 1 / 60});
const body = physics.addBody(null, {
  linearVelocity: [1, 0, 0],
  colliders: {shape: 'box', halfExtents: [2, 0.25, 0.35], mass: SEA_WATER * 0.7},
});
const mesh = {
  vertices: new Float64Array([
    -2, -0.25, -0.35, 2, -0.25, -0.35, 2, 0.25, -0.35, -2, 0.25, -0.35,
    -2, -0.25, 0.35, 2, -0.25, 0.35, 2, 0.25, 0.35, -2, 0.25, 0.35,
  ]),
  indices: new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
  ]),
};
const sea = new SpectralSea({waves: {
  frequencies: Float64Array.from([0.8, 1]),
  directions: Float64Array.from([0, Math.PI]),
  energy: Float64Array.from([0, 0.005, 0, 0]),
  depth: 8, density: SEA_WATER,
}});
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(new HullSolver(), {
    hulls: [{
      row: body.row, mesh, course: {speed: 1, lateralHeading: 0}, surgeAddedMass: true, shortWaveResistance: true,
      bilgeKeels: [
        {root: [0, -0.18, -0.35], span: [-0.04, -0.06], length: 2.4},
        {root: [0, -0.18, 0.35], span: [-0.04, 0.06], length: 2.4},
      ],
    }],
    sea,
    drift: false,
  })
  .couple(['hull', 'rigid'], 'staggered');
world.advance(60);
console.log(body.position);
```

For a moving cabin, attach its fixed fittings and camera to the hull's rigid pose. Give loose props separate rigid bodies and contact colliders in the same world. The deck collider belongs to the floating hull body. With that arrangement friction and normal contact follow the actual hull motion. `PhysicsBody.velocityAtPoint` reads the deck velocity at a world-space attachment point.

#### Hull motion drives a dispersive wake

`HullSolver` takes the same displacement mesh for a boat built in code or loaded from a model. Pass closed,
outward-wound triangles in body-local metres, with X along the hull and Y up. Apply an imported node's mesh
scale and pivot to the displacement vertices before binding them. Match the rigid body's mass, centre of
mass, inertia and starting pose when comparing two versions of a boat. The render mesh and its materials can
be authored independently of the submerged shape.

Set the second argument of `HullSolver` to enable signed waterplane sources, then give its `wakeSourceField` to `WakeSolver`. Both run at the world base rate in the same origin cell. Set `advance: true` to displace water at the leading end and draw it in behind the hull as it moves, alongside sources from heave, pitch and roll. It uses the rigid body's signed forward speed through the mean current and the hull mesh at its still-water draft. Omit `advance` to keep only the vertical motion sources. When a ship already supplies its advance wake through `ShipSolver` pressure, use one advance source per hull. Use a `minimumRadius` at least as large as half the wake cell diagonal so every source reaches the grid. Omit it for the geometric patch radius. Use the wake as a `SpectralSea` patch and pass that sea to the hull to return its pressure. The example enables `waterBelow` so the hull can also sample subsurface flow for drag and diffraction. Give the same wake to `WaterWake` to draw it.

For an advancing hull whose draft matters, set `submergedAdvance` instead of `advance` and connect `hull.submergedWakeSource` as the third argument to `WakeSolver`. Give two through nine increasing edges in metres down from still water, beginning at zero. The last edge must cover the hull’s reference draft and stay above the bed. The solver distributes each advancing face’s signed flux over the difference of its wetted section spans, then projects the depth bands to the surface with the linear finite-depth Green function. The original five-word source still carries heave, pitch and roll. For the optional port, `wake.submergedSourceWork()` reports the nonzero rows and extra forward transforms in the last executed step. Keep the source footprint inside the grid for continuous subcell
placement that preserves signed volume and its first horizontal moments. These are advancing sources for a prescribed
or driven course. The submerged footprint is at least half a longitudinal station interval and respects
`minimumRadius`. Its lateral spread comes from the samples on each wetted span. For work accounting use the
free or prescribed wake coupling in the loads entry below.

```ts
import {Physics} from 'margoengine/physics';
import {HullSolver, SEA_WATER} from 'margoengine/physics/seakeeping';
import {SpectralSea, WakeSolver} from 'margoengine/physics/sea';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
using physics = new Physics(null, {fixedTimestep: 1 / 60});
const body = physics.addBody(null, {
  linearVelocity: [1, 0, 0],
  colliders: {shape: 'box', halfExtents: [2, 0.25, 0.35], mass: SEA_WATER * 0.7},
});
const mesh = {
  vertices: new Float64Array([
    -2, -0.25, -0.35, 2, -0.25, -0.35, 2, 0.25, -0.35, -2, 0.25, -0.35,
    -2, -0.25, 0.35, 2, -0.25, 0.35, 2, 0.25, 0.35, -2, 0.25, 0.35,
  ]),
  indices: new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
  ]),
};
const hull = new HullSolver('hull', {minimumRadius: 0.35, submergedAdvance: [0, 0.0625, 0.125, 0.25, 0.3]});
const wake = new WakeSolver('wake', hull.wakeSourceField, hull.submergedWakeSource);
const sea = new SpectralSea({
  waves: {
    frequencies: Float64Array.of(0.5), directions: Float64Array.of(0), energy: Float64Array.of(0),
    depth: 3, density: SEA_WATER,
  },
  patches: [wake],
});
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(hull, {
    hulls: [{row: body.row, mesh}],
    sea,
  })
  .add(wake, {cells: [48, 32], cellSize: 0.25, depth: 3, sponge: 4, waterBelow: true})
  .couple(['hull', 'wake', 'rigid'], 'staggered');
world.advance(15);
console.log(wake.sample(2.5, 0).height);
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

`new EntrySolver()` uses the TypeScript section profiler. `await EntrySolver.load()` uses the optional Rust Wasm
profiler. Pass `threads: 2` or `threads: 4` to distribute section planes across the caller and real workers on Node
or in a cross-origin-isolated browser. The default native path uses one participant. Pass `signal` to cancel loading
and use `using` to release the pool. `workCounts()` reports the last accepted native step's geometric work.
Keep the sea in the entry solver's origin cell. Set `originCellSize` to the world's cell side length when the rigid
solver is in a different cell and the world uses a value other than 4096 m. An unusable sample or unrepresentable
load rejects that entry step before it publishes forces, cavity changes, events or foam.

```ts
import {Physics} from 'margoengine/physics';
import {EntrySolver} from 'margoengine/physics/entry';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
using physics = new Physics(null, {fixedTimestep: 1 / 960});
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
using entry = await EntrySolver.load();
const world = new PhysicsWorld({rate: {num: 960, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(entry, {bodies: [{row: ball.row, mesh: {vertices, indices}}], sea: {elevation: () => 0}, level: 4})
  .couple(['entry', 'rigid'], 'staggered');
world.advance(96); // a tenth of a second
console.log(entry.splashes().map((e) => e.kind).join(' ')); // "entry seal": in with a cavity, which pinches
```

#### Launch a hull with passive entry effects

Set `effectsOnly: true` on an `EntryBody` when a `HullSolver` handles that body's loads and wake. Entry follows the rigid pose and the local water to produce cavity, splash and foam events. The hull supplies the force and displaced volumes for this row. The default is false, so other bodies in the same EntrySolver retain their usual water-entry loads.

For an open cavity to change the hull's water load, enable `cavityPressure` on the EntrySolver (default false), connect its field to the HullSolver, and step EntrySolver before HullSolver at the same rate. HullSolver clips the immersed mesh at the cavity contact plane, putting the trailing side at atmospheric pressure until the cavity closes.

```ts
import {Physics} from 'margoengine/physics';
import {EntrySolver} from 'margoengine/physics/entry';
import {SpectralSea, WakeSolver} from 'margoengine/physics/sea';
import {HullSolver} from 'margoengine/physics/seakeeping';
import {PhysicsWorld, RigidSolver, worldMemory} from 'margoengine/physics/world';

await Physics.load();
const world = new PhysicsWorld({rate: {num: 60, den: 1}, memory: worldMemory(false)});
using physics = new Physics(null, {fixedTimestep: 1 / 60, arena: world.arena});
const boat = physics.addBody(null, {
  position: [-0.5, 0.36, 0], linearVelocity: [0.8, -4, 0],
  enabledRotations: [false, false, false],
  colliders: {shape: 'box', halfExtents: [0.5, 0.065, 0.18], mass: 9},
});
const mesh = {
  vertices: Float64Array.of(-0.5, 0, 0, -0.5, 0.13, 0.18, -0.5, 0.13, -0.18,
    0.5, 0, 0, 0.5, 0.13, 0.18, 0.5, 0.13, -0.18),
  indices: Uint32Array.of(0, 1, 2, 3, 5, 4, 0, 4, 1, 0, 3, 4, 0, 5, 3,
    0, 2, 5, 1, 5, 2, 1, 4, 5),
};
const entry = new EntrySolver('entry', {cavityPressure: true});
const hull = new HullSolver('hull', {minimumRadius: 0.12}).connectEntryCavity(entry.cavityPressureField);
const wake = new WakeSolver('wake', hull.wakeSourceField);
const sea = new SpectralSea({
  waves: {
    frequencies: Float64Array.of(0.1, 0.2, 0.4), directions: Float64Array.of(0, Math.PI),
    energy: new Float64Array(6), depth: 2, density: 1025,
  }, patches: [wake],
});
world.add(new RigidSolver(), {physics})
  .add(hull, {hulls: [{row: boat.row, mesh}], sea, radiation: false, rollDamping: false, greenWater: false})
  .add(wake, {cells: [40, 40], cellSize: 0.15, depth: 2, waterBelow: true})
  .add(entry, {bodies: [{row: boat.row, mesh, contactAngle: 160, effectsOnly: true}], sea})
  .couple(['entry', 'hull', 'wake', 'rigid'], 'staggered');
world.advance(14);
console.log(entry.splashes()[0]?.kind); // entry
```

### Water that splashes and pours (`FlipSolver`, `DeckWaterSolver`, `@margoengine/physics/flip`)

`FlipSolver` is FLUID-03: water in a box of cells that collapses, splashes, overturns and pours, as APIC particles
(Jiang et al. 2015) on a grid that keeps it incompressible with a free surface (Gibou et al.'s ghost fluid). Give it
the box (`cells`, `cellSize`, `origin`), where the water starts (`initial(x, y, z)`, eight particles a cell), solid
boxes it flows round (`solids`; it slips along them as along the box's own sides) and the sides open to the air
(`open`), where water leaves for the sea
(`seaSources()`, for a WakeSolver). Each world step takes as many substeps as keep every particle within a cell, and after each the particles that cluster are moved apart by Kugelstadt et al.'s implicit density projection, so the water keeps its volume.
`positions()` gives the particles for drawing, `velocityAt` and `pressureAt` read the grid. Martin and Moyce's dam
break is its check: the front within 2 percent of their measurements. In three dimensions, Lobovsky et al.'s tank
(`node scripts/check-dambreak3d.mjs`) gives the front's speed within the measured range and the bottom of the far
wall its measured peak pressure (docs/limits.md).

Crashing crests: give a box a `sea` (a `SpectralSea`, or anything with `elevation(x, z, t)` and `water.sample`) and no
`initial`, and it starts as that sea, its water moving as the sea's does. Its four sides then take the sea's own
velocity, and a band of `blend` cells (6) inside them is held to the sea's motion and level (the hybrid of Chentanez,
Muller and Kim 2014). Waves run in and out, and inside the box they are free to steepen, overturn and break. Checked:
a wave passes through in phase, converging with the cells, and a calm sea's box stays still. A dispersively focused
packet in Erinin et al.'s tank overturns and plunges (`node scripts/check-breaker.mjs`, minutes a run, measured as they
measure it), but not yet like theirs: it plunges only with a crest half again as tall as theirs, and its jet's speed
and timing still change with the grid (docs/limits.md, KB-FLIP-CREST1). Give a breaking crest a dozen cells or more.

Giving the sea its water: made with `new FlipSolver(id, {seaSource: true})`, the box publishes `${id}.seaSource`, rows a
`WakeSolver` made with that field (`new WakeSolver('wake', liquid.seaSourceField)`) adds to its surface. The rows carry
what leaves over the open sides and, held to a sea, what crosses the sides held to it and what the band removes or adds
to hold the sea's level, in tiles of `seaTile` m. The box and the wake keep their water between them to round-off, and
the sea's `water`, with the wake made with `waterBelow`, carries the wake's waves into the box. Waves made inside the box
still end at its band: their water goes to the wake there, but not yet as the waves they were (docs/limits.md).

Air and spray for the foam and bubbles (SEA-13): `aeration()` is the air the liquid closed over in the world's last
base step, the cavity a plunging crest traps, measured by the water missing there, as a source a `BubbleSolver` takes
(`sources: () => liquid.aeration()`); `foam` (a `FoamSolver`) whitens the surface over each cavity; `spray()` lists the
water in the air, drops and sheets thinner than a cell, with its velocity.

```ts
import {BubbleSolver} from 'margoengine/physics/bubbles';
import {FlipSolver} from 'margoengine/physics/flip';
import {PhysicsWorld} from 'margoengine/physics/world';

const liquid = new FlipSolver('liquid');
const bubbles = new BubbleSolver('bubbles');
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(liquid, {
    cells: [40, 40, 1],
    cellSize: 0.02,
    initial: (x, y) => y < 0.2 || (Math.abs(x - 0.4) < 0.08 && y > 0.45 && y < 0.6), // a block over a pool
  })
  .add(bubbles, {sources: () => liquid.aeration()})
  .couple(['liquid', 'bubbles'], 'staggered');
world.advance(45);
console.log(bubbles.ledger().taken > 0); // true: the splash trapped air and the bubbles took it in
```

```ts
import {FlipSolver} from 'margoengine/physics/flip';
import {WakeSolver} from 'margoengine/physics/sea';
import {PhysicsWorld} from 'margoengine/physics/world';

const liquid = new FlipSolver('liquid', {seaSource: true});
const wake = new WakeSolver('wake', liquid.seaSourceField);
const sea = {
  elevation: (x: number, z: number) => wake.sample(x, z).height,
  water: {
    sample: (x: number, y: number, z: number, _t: number, o = {velocity: [0, 0, 0] as [number, number, number], density: 1000, temperature: 288}) => {
      wake.velocityAt(x, y, z, o.velocity);
      return o;
    },
  },
};
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(wake, {cells: [64, 64], cellSize: 0.125, density: 1000, waterBelow: true})
  .add(liquid, {
    cells: [16, 6, 16],
    cellSize: 0.1,
    origin: [-0.8, -0.3, -0.8],
    sea,
    blend: 3,
    seaTile: 0.2,
    initial: (x, y, z) => y < 0.3 || (Math.hypot(x - 0.8, z - 0.8) < 0.25 && y < 0.4), // a mound in the box
  });
world.advance(30);
console.log(liquid.seaSourceField?.name); // 'liquid.seaSource'
```

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

`TracerSolver` is the physics framework's tracers (SEA-15): dye, discoloured water, silt and cargo plumes, and oil slicks. Each is a cloud of particles of a material, carried by the water's velocity at its depth (`water`, any `FlowField` of water; still water by default). Turbulence spreads them as a random walk, so a cloud's variance grows as 2 K t (`horizontalDiffusivity`, default 0.1 m^2/s; `verticalDiffusivity`, default 0.001). Grains settle at Ferguson and Church's speed for their size and density and come to rest on the `bed` (a terrain bed, or a depth, default 30 m below `waterLevel`). Floating material stays on the surface and drifts with the water there plus a share of the `wind` (`windage`, default 3 percent). `sources` release a material (one of `TRACER_MATERIALS`: `dye`, `silt`, `sand`, `ironOre`, `coal`, `grain`, `oil`, or your own `{density, diameter, shape, floats, windage, colour}`) at a fixed place or along a path (a breach in a moving hull), at a rate in kg/s that may change with time, between `start` and `stop`. A damaged hull's cargo comes in by itself: the solver reads the `hullBreaches` port of a `HullSolver` with compartments and releases what each breach carries out, as its cargo's material, at its centre (`breaches`, default 64 of them; 0 none). `particleMass` (default 1 kg) sets how fine the cloud is, and `capacity` (default 20,000) how many particles it may hold.

The `budget` records mass released, in the water, on the surface and on the bed. Oil vapour and biodegraded mass have separate queries. These inventories close to floating-point roundoff in the mass-ledger checks. `concentration(min, max, cells)` gives the concentration (kg/m^3) on a grid and the colour it gives the water, `particlesOf()` every particle, and the particles are the registry field `tracers` for the sea surface to tint its water. A ship's `wakeTint` (`@margoengine/water`) remains as an art override for a stern trail and is deprecated as the source of discoloured water: release the cargo here instead.

Read `particlesOf()`, `concentration()` and the mass ledger between accepted steps. External water and wind queries sample their own origin cells. Give the tracer the world’s cell size. Non-finite source or field samples raise a [coded error](https://margoengine.com/errors#water-tracers) without replacing the accepted parcel and ledger state.

Attach an optional disposable `loadTracerRandomKernel({threads, signal})` to `randomKernel` for the parcel diffusion loop. The default is one participant. More participants use actual native workers in a runtime with shared Wasm memory. Draws still use each parcel’s slot and tick. The example keeps the kernel alive until its world finishes advancing.

```ts
import {loadTracerRandomKernel, TracerSolver} from 'margoengine/physics/tracers';
import {PhysicsWorld} from 'margoengine/physics/world';

// A hull steaming at 3 m/s through a 0.4 m/s current leaks iron ore from a breach, less as its hold empties.
const water = {medium: 'water' as const, cell: [0, 0, 0] as const, sample: (_x: number, _y: number, _z: number, _t: number, out = {velocity: [0, 0, 0] as [number, number, number], density: 1025, temperature: 285}) => ((out.velocity = [0.4, 0, 0]), out)};
using randomKernel = await loadTracerRandomKernel();
const tracers = new TracerSolver();
const world = new PhysicsWorld({rate: {num: 24, den: 1}}).add(tracers, {
  water,
  randomKernel,
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

Pass `sea` to place a slick on a live surface, use its orbital flow below the surface, and reflect submerged parcels
from the moving waterline. `waterLevel` offsets the sea's still-water plane. An explicit `water` field overrides flow
while the sea still sets the waterline. The tracer's `cellSize` defaults to 4096 m and must match its physics world.

```ts
import { SpectralSea } from 'margoengine/physics/sea';
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const energy = new Float64Array(12);
energy[4] = 0.25 / (0.2 * Math.PI);
const sea = new SpectralSea({ waves: {
  frequencies: new Float64Array([0.2, 0.4, 0.6]),
  directions: new Float64Array([0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]),
  energy, depth: Infinity, density: 1025,
} });
const slick = new TracerSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(slick, {
  sea, sources: [{ material: 'oil', position: [0, 0, 0], rate: 60, stop: 1 / 60 }],
});
world.advance(1);
const { position: [x, y, z] } = [...slick.particlesOf()][0]!;
console.log(y === sea.elevation(x, z, 1 / 60)); // true
```

Use `oilSpills` for a finite release that spreads by Fay's radial laws. Set its mass in kilograms, position in
local metres, and `spreadingCoefficient` in N/m (air–water tension minus oil–air and oil–water tensions).
Zero selects gravity-driven spreading. Each release reserves `parcels` slots from `capacity` (default 128,
minimum 2), follows the supplied water and wind, and starts at `start` seconds (default 0). The default
material is `TRACER_MATERIALS.oil`. Ordinary sources and cargo can use the other slots.

```ts
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const oil = new TracerSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(oil, {
  oilSpills: [{ mass: 0.025, position: [0, 0], spreadingCoefficient: 0.0003, parcels: 64 }],
  horizontalDiffusivity: 0,
});
world.advance(60);
console.log(oil.budget.surface, [...oil.particlesOf()].length); // 0.025 64
```

Set `releaseDuration` in seconds to feed the total `mass` into one well-mixed patch at a constant rate.
The default is 0, an instantaneous release. With a positive duration, use zero `spreadingCoefficient` and
`yieldStress` and omit evaporation and breaking dispersion. The radius grows during the feed and continues
from the same radius after the feed stops. The supplied current and wind move the patch as a whole.

```ts
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const feed = new TracerSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(feed, {
  oilSpills: [{ mass: 0.5, position: [0, 0], spreadingCoefficient: 0, releaseDuration: 20 }],
  horizontalDiffusivity: 0,
});
world.advance(60);
console.log(feed.budget.surface); // 0.025 kg after one second
```

Set `yieldStress`, in Pa, for a coherent waxy film. The default is 0. A positive value uses the fixed-volume
gravity-spreading model from Brönner et al. with zero `spreadingCoefficient` and no evaporation or breaking-wave
dispersion. The film approaches a finite radius. Read `oilFilm(index)` for the cell-local centre, nominal radius and
mean and central thicknesses in metres. `index` is the zero-based position in `oilSpills`. Before release or once
surface oil is gone, `oilFilm` returns `undefined`. Local mixing and shear can distort the actual parcel cloud.

```ts
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const wax = new TracerSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(wax, {
  oilSpills: [{ mass: 3.48, position: [0, 0], spreadingCoefficient: 0, yieldStress: 0.36 }],
  horizontalDiffusivity: 0,
});
world.advance(60);
const film = wax.oilFilm(0);
console.log(film?.radius, film?.centreThickness);
```

Set `evaporation` for a release with a modified distillation curve. Supply slick temperature and initial boiling
point in kelvin, the slope in kelvin per distilled volume fraction, and air-side transfer in m/s. All four inputs
stay constant for the release. By default, the exposed area grows with Fay spreading. For a known fixed area, set
`evaporation.referenceThickness` to the initial volume divided by that area, in metres. This changes how the
solver calculates evaporation while the visible slick continues to spread. `evaporatedMass` is cumulative
vapour mass in kilograms. Add it to the water,
surface and bed terms to account for `budget.released`.

```ts
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const oil = new TracerSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(oil, {
  oilSpills: [{
    mass: 0.025, position: [0, 0], spreadingCoefficient: 0.0003,
    evaporation: { temperature: 290, initialBoilingPoint: 400, distillationSlope: 650, massTransferCoefficient: 0.003 },
  }],
});
world.advance(600);
console.log(oil.evaporatedMass > 0); // true
```

Set `emulsification` to let floating oil take up water. Supply the maximum water fraction by volume, the
field half time at 10 m/s wind in seconds, and the dry oil viscosity in Pa·s. Wind uses the existing sampler
at 10 m above the slick, with a calm value of 0 m/s when omitted. The optional `minimumOilThickness`
halts uptake below the supplied oil-only thickness in metres. The default is zero. `oilEmulsion(index)`
gives water mass, water fraction, density and dynamic viscosity. `oilFilm(index)` includes the added
water in the thickness. `budget` continues to count oil mass.

```ts
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const slick = new TracerSolver();
const world = new PhysicsWorld().add(slick, {
  oilSpills: [{
    position: [0, 0], mass: 5, spreadingCoefficient: 0.001,
    emulsification: { maximumWaterFraction: 0.75, halfTimeAt10: 1800, oilViscosity: 0.027 },
  }],
});
world.advance(600);
console.log(slick.oilEmulsion(0)!.waterMass > 0); // true
```

Set `dissolution` to exchange named soluble oil fractions, listed in the order you want to read them,
with a well-mixed volume of water in m³. For each fraction, supply its original oil mass share,
its oil-to-water equilibrium concentration ratio and its interfacial transfer velocity in m/s.
Fractions outside the list remain in the slick. The optional `transferArea` is in m² and defaults to
the growing Fay area. An optional `biodegradationHalfLife` removes dissolved oil on a first-order
time scale in seconds. Its default preserves the whole soluble inventory. `oilSolute(spill, solute)`
reports dissolved and biodegraded mass in kg. Dissolved oil counts in `budget.water`.
`biodegradedMass` reports the total transformed oil across all releases. Use this closed-pool model
for a fixed release with optional emulsification. Bulk evaporation and droplet dispersion use separate
oil models with their own inputs.

```ts
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const slick = new TracerSolver();
const world = new PhysicsWorld().add(slick, {
  oilSpills: [{
    mass: 5, position: [0, 0], spreadingCoefficient: 0.001,
    dissolution: {
      waterVolume: 0.5,
      solutes: [{ massFraction: 0.05, oilWaterPartition: 100, transferVelocity: 1e-5, biodegradationHalfLife: 3600 }],
    },
  }],
});
world.advance(600);
console.log(slick.oilSolute(0, 0)!.dissolved > 0); // true
```

Set `verticalDiffusivityProfile` to use different mixing rates at different depths. Supply at least two depths in
ascending order, in metres below the local free surface, with diffusivity in m²/s. The solver interpolates between
knots, extends the endpoints as constants and includes the drift associated with the diffusivity gradient. Omitting
the profile uses the scalar `verticalDiffusivity`.

```ts
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const dye = new TracerSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(dye, {
  verticalDiffusivityProfile: [
    { depth: 0, diffusivity: 0.01 }, { depth: 4, diffusivity: 0.001 }, { depth: 10, diffusivity: 0.002 },
  ],
  sources: [{ material: 'dye', position: [0, -4, 0], rate: 60, stop: 1 / 60 }],
});
world.advance(1);
console.log(dye.budget.water); // 1
```

Set `stokesSpectrum` to advect tracers with wave-averaged Stokes drift from a fixed directional spectrum. An
optional `water` field supplies the Eulerian mean current. With `sea` present, its elevation still sets the local
surface. Omit `stokesSpectrum` to resolve the existing instantaneous sea and wake velocities.

```ts
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const dye = new TracerSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(dye, {
  stokesSpectrum: {
    frequencies: Float64Array.of(0.2), directions: Float64Array.of(0), energy: Float64Array.of(0.05),
    depth: Infinity, density: 1025,
  },
  horizontalDiffusivity: 0, verticalDiffusivity: 0,
  sources: [{ material: 'dye', position: [0, -1, 0], rate: 60, stop: 1 / 60 }],
});
world.advance(60);
console.log(dye.particlesOf().next().value!.position[0] > 0); // true
```

Set `horizontalDispersion` to make the unresolved spreading of each release depend on its scale. The
`referenceScale` is three times the RMS radial displacement in metres at which `horizontalDiffusivity`
applies. The exponent defaults to Richardson's 4/3 and accepts values in [0, 2). `initialScale` defaults to
zero for a point release. A nonzero value sets the initial mixing scale in metres and leaves emission positions
under the source's control.

```ts
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const dye = new TracerSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(dye, {
  horizontalDiffusivity: 0.75, horizontalDispersion: { referenceScale: 3 }, verticalDiffusivity: 0,
  sources: [{ material: 'dye', position: [0, -1, 0], rate: 60, stop: 1 / 60 }],
});
world.advance(60);
console.log(dye.budget.water); // 1
```

Set `dispersion` on a finite oil release to entrain buoyant droplets under breaking waves. Supply an
oil-specific Delvigne–Sweeney `entrainmentCoefficient`, a `maximumDiameter` in metres, and breaker
conditions. `minimumDiameter` defaults to 3 µm and `classes` to 24. Each size class reserves one additional
parcel slot. Breaker `energy` is dissipated energy in J/m², `turnover` is swept area fraction per second,
and `height` is in metres. Use fixed conditions or a deterministic function sampled at the slick centre.
Submerged oil is included in `budget.water` and returns to its parent slick when it reaches the surface.

```ts
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const oil = new TracerSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(oil, {
  oilSpills: [{ mass: 0.025, position: [0, 0], spreadingCoefficient: 0, dispersion: {
    entrainmentCoefficient: 840, maximumDiameter: 0.0004,
    breaking: { energy: 15, turnover: 0.5, height: 0.3 },
  } }],
});
world.advance(1);
console.log(oil.budget.water > 0); // true
```

Set `bedWash` to lift sediment below a resolved propeller or thruster flow. Give the `water` field, the x–z
rectangle in the tracer origin cell, and a `referenceHeight` and `roughnessLength` in metres. Choose the
reference height inside the local logarithmic layer. The grid defaults to 12 × 12 and supports up to 65,536
midpoint samples. `bedJets` supplies the grain and pickup settings. `TracerSolver.withBedWash()` exchanges
the released mass with a live `TerrainBed` using `bedJets.mobileLayer`. Set `thrusterOutlet` on a ship to include
its live bow jet in `ShipSolver.water`. Put the ship,
rigid bodies, tracer and mutable bed in the same staggered group, in that order.

```ts
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const tracer = new TracerSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(tracer, {
  bed: 1,
  bedWash: {
    water: { medium: 'water', cell: [0, 0, 0], sample: () => ({ velocity: [2, 0, 0], density: 1025, temperature: 285 }) },
    bounds: [-0.5, -0.5, 0.5, 0.5], cells: [2, 2], referenceHeight: 0.05, roughnessLength: 0.001,
  },
  bedJets: { grains: { density: 2650, diameter: 125e-6, colour: [0.7, 0.6, 0.4] }, denseSand: true },
});
world.advance(1);
console.log(tracer.jetErosion > 0); // true
```

Set `flocculation` to track the aggregate diameter of a cohesive sediment as it grows, breaks up and settles.
The default material is `silt`, and its grain diameter supplies the primary diameter. A custom material can
set another primary diameter. `initialDiameter` defaults to that primary diameter. Supply aggregation in
m²/kg, breakup in s½/m², dry concentration in kg/m³ and shear rate in s⁻¹. A deterministic `environment`
function can supply concentration and shear at each parcel. The ledger continues to count dry sediment mass.
Set `yieldForce` in newtons to increase breakup as aggregates approach the Kolmogorov microscale.
Use a positive force below `Math.exp(4) * waterDensity * viscosity ** 2 / 9`, where `viscosity` is
kinematic. Omit it for the original Winterwerp kinetics.

```ts
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const tracer = new TracerSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(tracer, {
  sources: [{ material: 'silt', position: [0, -1, 0], rate: 60, stop: 1 / 60 }],
  horizontalDiffusivity: 0, verticalDiffusivity: 0,
  flocculation: { aggregation: 40_000, breakup: 1e8, environment: { concentration: 0.4, shearRate: 4 } },
});
world.advance(60);
console.log(tracer.particlesOf().next().value!.position[1] < -1); // true
```

When one opening carries several grain sizes, set `breachMixes` for its rigid body row and its index in the hull's
`openings` array. Each positive mass fraction gets its own parcel carry. Without a mixture, the port's cargo code
selects one material. This configuration describes 12 mm pellets and fines at body row 0, opening 2.
Openings can publish from a different origin cell. Pass `cellSize: world.cellSize` to the tracer when the world uses
a custom cell length.

```ts
import { TracerSolver } from 'margoengine/physics/tracers';
import { PhysicsWorld } from 'margoengine/physics/world';

const cargo = new TracerSolver();
const world = new PhysicsWorld().add(cargo, {
  breachMixes: [{ body: 0, opening: 2, fractions: [
    { material: 'ironOre', fraction: 0.2 },
    { material: { density: 3800, diameter: 0.012, shape: 0.4, colour: [0.25, 0.14, 0.09] }, fraction: 0.8 },
  ] }],
});
world.advance(1);
console.log(cargo.budget.released); // 0 until a connected hold reports cargo outflow
```

For a ray, enable `bedJets` to couple swimming impulses to the erodible bed. A downward fin impulse spreads
as it reaches the bed. The default `shear: 'wall-jet'` computes a radial submerged-jet wall stress with zero
shear at stagnation, an off-centre peak and an outward decay. Eroded mass is integrated over the affected annuli.
Use `shear: 'footprint'` for an average stress over a single footprint. Clearances shorter than one nozzle diameter
use this simpler model. Sand (default) or silt lifts where shear exceeds the Soulsby–Whitehouse threshold for the
grain size, water density and viscosity. The default van Rijn pick-up
rate increases with the three-halves power of relative excess stress. Give `criticalShields` to override onset,
or set `erodibility` to use a linear rate in kg/m²/s at unit excess stress for a prescribed bed. `availableMass`
defaults to an unlimited layer. The parcels enter suspension at van Rijn's reference plane, 1% of the local
water depth above the bed by default. Set `suspensionReferenceHeight` to half the bedform height or to the
equivalent roughness in metres when bedform dimensions are unavailable. The solver applies the same 1% minimum
and requires the plane to be below the surface. The parcels drift with `water` and settle at their grain speed. Read `jetErosion`
for kilograms lifted, and `particlesOf()` or `concentration()` for a renderer. `TracerSolver.withBedChange(id)` also deforms a live
`TerrainBed`. Give `mobileLayer.thickness` in metres and `porosity` as a volume fraction in [0, 1). Place the layer
above bedrock and use one sediment writer on it. The layer loses the mass carried in the puff and receives it when
the grains settle. Each vertex supplies its own mobile stock, so erosion can continue next to exposed bedrock.
Both modes are off by default. The [rendered coupling fixture](../environment/tests/swim-sediment.html)
uses the moving bed mesh as well as the rising, drifting and settling sand.

Give `bedJets.grains` a sinking `TracerMaterial` with a diameter in metres and density in kg/m³ to match a measured
grain size. For clean, densely packed sand under strong forcing, set `bedJets.denseSand` to `true` (default `false`).
This applies van Rijn et al.'s high-stress damping above a grain Shields number of one. It uses the nonlinear
pickup law and applies to both fin jets and wash. The paper's tested sands were 51–562 µm at porosity near 0.4.

```ts
import { TerrainBed } from 'margoengine/physics/earth';
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
const seabed = new TerrainBed();
world.add(seabed, { columns: 40, rows: 40, width: 4, depth: 4, centre: [0, 0],
  elevations: () => -0.5, bedrock: () => -0.502 });
const sediment = TracerSolver.withBedChange('sand');
world.add(sediment, { bed: seabed.bed, bedJets: { availableMass: 0.023,
  mobileLayer: { thickness: 0.002, porosity: 0.4 } } });
world.couple([rays.describe().id, 'sand', 'bed'], 'staggered');
world.advance(1);
console.log(sediment.jetErosion > 0, seabed.volume(-0.5) < 0); // true true
```

Fin wakes can cross origin cells before lifting grains from the live bed. For custom-size cells, pass
`cellSize: world.cellSize` to the swimmer and tracer.
On terrain, the fin jet projects its pickup annuli onto the local bed plane and uses the impulse along the bed normal.

Use `submergedJetWallShear` to sample the steady flat-bed stress from a known nozzle. Its arguments use SI units.
Set `turbulentTransition: true` on the nozzle probe or in `bedJets` to include the secondary shear rise at
clearances between two and four nozzle diameters. The default keeps the core and outer wall-jet model.

```ts
import { submergedJetWallShear } from 'margoengine/physics/tracers';

const jet = { height: 0.2, diameter: 0.1, speed: 0.426, density: 1000, viscosity: 1e-6 };
console.log(submergedJetWallShear(jet, 0), submergedJetWallShear(jet, 0.4) > 0); // 0 true
const developed = submergedJetWallShear({ ...jet, turbulentTransition: true }, 0.185);
console.log(developed > submergedJetWallShear(jet, 0.185)); // true
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
- `coriolis`, the Earth's rotation: a Coriolis parameter f in 1/s, or `{latitude, north}` (radians; `north` from -Z toward +X, default 0) for the beta plane about the grid's centre. Each substep turns the momentum by f dt exactly, so currents swing right in the north and a Kelvin wave keeps to its coast (default none);
- `timeScale`: seconds of the water's time per second of world time (default 1). 3600 runs an hour of surge or flood each world second, for a timelapse or a long test. Each world step is then many of the water's seconds, taken in as many substeps as the Courant bound asks, each the longest it allows, never one long step. `water.work` counts the steps and substeps.
  - On the water's time: its own inputs (the inflows' discharges, the sides' levels, and a surge's pressure and ramp).
  - On the world's time: fields (the rain, the wind, the tide), each running at the water's scale. A field gives its `timeScale` (one that gives none runs at the world's), and the water refuses, with a `state` error, a wind or rain at another scale: give its maker the water's `timeScale`, or set `timeScale` on one you write as a function of time (still read at the world's time t, its weather at t times the scale). The `CelestialSolver` declares its own, so the surge refuses a tide at another scale.
  - What the water publishes carries its scale: the `surfaceWater` field, the surge's potential and `water.flow`. The world refuses, with a `state` error naming the fix, a solver at another scale that reads them or is given `water.flow`. Ships, hulls, loads, tracers and anything riding the water run on the world's time, so a sped-up surge is for scenes of the water alone, or of solvers that take the same `timeScale` (the surge, the synoptic weather);
- `courant` (default 0.4, at most 0.5), `density` (default 1000), `rate` (its rate level, default the world's base rate).

It publishes the field `surfaceWater`: per cell, the depth h in m and the discharges hu and hv in m^2/s, as f32, x fastest. It takes waves' forcing from the field `surfaceWaterForcing`, which a `SurfSolver` adds to: per cell, the force of the radiation stress over the density, the Stokes drift (the water's momentum is then Lagrangian, and its bed friction acts on what is left of it) and the orbital velocity that stirs the bed. It also takes the field `surfaceWaterPotential`, which a `SurgeSolver` adds to: per cell, a height psi whose gradient pushes the water, -g h grad(psi). The water adds it to its bed in its hydrostatic reconstruction, so water at rest under it stands at -psi to rounding. `water.sample(x, z)` gives the depth, the surface height and the depth-averaged velocity there; `water.flow` is the water as a framework `FlowField` (for tracers, debris and bodies); `water.volume()` the volume, and `water.budget` what came in by the inflows and by rain and what left over the sides since the start, in m^3.

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

#### Projected body drag at a wet/dry shoreline

`ShallowWaterSolver.withProjectedBodyDrag` couples a compact body or hull to water that can drain or rewet.
The request takes the previous rigid pose. The water completes its transport and dry-cell momentum resets,
then recomputes the wetted profile and implicit drag from its final f64 state. The relay sends the accepted
horizontal impulse and corresponding moment to rigid on the same tick. Fully dry profiles receive zero.
The exchange changes horizontal discharge and leaves volume to the water solver.
On periodic sides the profile samples both sides of the seam and uses local periodic images for its
moment arms. A one-cell periodic axis contributes one fluid mass.
The drag solve reads the rigid mobility from the same pose. A locked axis contributes zero mobility while
its support still receives the reaction. `readMobility` defaults to true.

```ts
import {Physics} from 'margoengine/physics';
import {bedSurface} from 'margoengine/physics/earth';
import {ShallowWaterSolver} from 'margoengine/physics/hydro';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
const gravity = [0, 0, 0] as const;
using physics = new Physics(null, {gravity, fixedTimestep: 1 / 60});
const debris = physics.addBody(null, {
  position: [0, 0.4, 0], colliders: {shape: 'sphere', radius: 0.2, mass: 20}, linearDamping: 0,
});
const bed = bedSurface({columns: 2, rows: 1, width: 2, depth: 1, centre: [0, 0]}, new Float64Array(6));
const {water, request, relay, order} = await ShallowWaterSolver.withProjectedBodyDrag([
  {row: debris.row, halfHeight: 0.2, area: Math.PI * 0.2 ** 2, dragCoefficient: 0.8},
]);
const world = new PhysicsWorld({gravity, rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(request, {})
  .add(water, {bed, depth: 0.75, velocity: () => [1, 0], roughness: 0})
  .add(relay, {}).couple(order, 'staggered');
world.advance(1);
console.log(debris.linearVelocity[0] > 0);
```

Use the same fixed origin and rate for all four solvers. The mode accepts one configured profile per dynamic
body and processes overlapping profiles in ascending rigid row order. Use free horizontal and rotational
motion to close an isolated water/body momentum and energy ledger. Guides and rigid contacts can exchange
momentum with their supports. Disable duplicate form drag on the same body in a concurrent `LoadSolver` or
`HullSolver`. Each kick enters the completed water state, so its effect on transport starts in the next step.

#### Moving obstructions and pressure reaction

`ShallowWaterSolver.withRigidFootprint` uses a full-depth convex obstruction. Describe it in horizontal
metres relative to an upright rigid body's centre of mass. The body moves on X/Z and receives the
water's accepted pressure impulse. The optional factory creates the same-rate predictor and reaction
solvers and supplies their staggered order. `withRigidCylinder` takes a radius for a circular footprint.
`withCylinder` exposes motion and reaction fields for a prescribed path. These modes use a flat, wet,
periodic channel on the world clock.

Both footprint extents must fit one grid cell. A nearly closed cell shares its conserved water state
with a fluid neighbour for that pressure step.
A fully covered cell publishes zero depth and receives water through the shared state when it reopens.

```ts
import {Physics} from 'margoengine/physics';
import {bedSurface} from 'margoengine/physics/earth';
import {ShallowWaterSolver} from 'margoengine/physics/hydro';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
const gravity = [0, -9.81, 0] as const;
using physics = new Physics(null, {gravity, fixedTimestep: 1 / 60});
const obstruction = physics.addBody(null, {
  position: [0, 0.4, 0], linearVelocity: [0.4, 0, 0],
  enabledTranslations: [true, false, true], lockRotations: true, canSleep: false,
  colliders: {shape: 'box', halfExtents: [0.18, 0.7, 0.14], mass: 512},
});
const {water, predictor, reaction, order} = await ShallowWaterSolver.withRigidFootprint({
  bodyRow: obstruction.row, centre: [0, 0],
  footprint: [[-0.18, -0.14], [0.18, -0.14], [0.18, 0.14], [-0.18, 0.14]],
});
const bed = bedSurface({columns: 8, rows: 8, width: 4, depth: 4, centre: [0, 0]}, new Float64Array(81));
const world = new PhysicsWorld({rate: {num: 60, den: 1}, gravity})
  .add(new RigidSolver(), {physics})
  .add(predictor, {})
  .add(water, {
    bed, depth: 0.9,
    sides: {minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic'},
  })
  .add(reaction, {})
  .couple(order, 'staggered');
const volume = water.volume();
world.advance(12);
console.log(obstruction.linearVelocity[0] < 0.4, Math.abs(water.volume() - volume) < 1e-9);
```

### Tides, storm surge and currents (`@margoengine/physics/surge`)

`SurgeSolver` forces a `ShallowWaterSolver` with the air's pressure and the Sun's and Moon's pull (SEA-07). Both act on the water as the gradient of a height:
- the inverse barometer (p - p_ref) / (rho g), a centimetre a hectopascal;
- the equilibrium tide gamma_2 U / g of the tide-generating potential U, from the world's `CelestialSolver` (`@margoengine/physics/space`), with the Love numbers' reduction gamma_2 = 0.693.

It sums them into one forcing potential per cell, the field `surfaceWaterPotential`. The water adds it to its bed in its hydrostatic reconstruction, so the force is -g h grad(psi), and water at rest stands at -psi to rounding: a lake under a still low stands at the inverse barometer and does not creep. Couple it before the water: `world.couple(['surge', 'water'], 'staggered')`. Construct it with `new SurgeSolver('surge', {tide: true})` to read the world's tide (add a `CelestialSolver` first). Its settings:
- `water`: the `ShallowWaterSolver`, added to the world first;
- `pressure`: the air's pressure at the water, a function of `(x, z, time)` giving Pa, `time` the water's (default none);
- `reference`: the pressure the water is level under, Pa (default the mean over the wet water each step, so a closed lake keeps its mean level; pass 101325 for a sea whose open side is held);
- `site`: where the world's origin lies on the Earth, `{latitude, longitude}` in radians and `north` (radians from -Z toward +X, default 0), for the tide;
- `love` (default 0.693), `ramp` (seconds of the water's time over which the forcing grows from nothing, tanh-shaped, default 0) and `rate`.

The pressure is a function of the water's time, so with the water's `timeScale` it is written in storm time. The tide comes from the `CelestialSolver` at the world's time: give it the water's `timeScale` too.

`potentialAt(x, z)` reads the last accepted potential. A rejected pressure sample or celestial port preserves the accepted parts and potential, with an error code that names the fix. `SurgeSolver.load(id?, options?, {threads, signal})` selects the native tide and pressure calculation. With one participant by default, it preserves scalar results. Two or four participants run in Node or an isolated browser worker. Use `using` to release the helpers after the world finishes. `readNativeWork()` gives the last accepted grid work.

The shallow water also solves:
- `wind`, a `Wind` field 10 m above the water: its stress rho_a C_D |U| U, with Garratt's C_D = (0.75 + 0.067 U) 1e-3 up to `windDragLimit` (default 2.5e-3, where the sea's roughness saturates in strong winds, Donelan et al. 2004);
- `coriolis`, the Earth's rotation: a Coriolis parameter f in 1/s, or `{latitude, north}` for the beta plane about the grid's centre. It turns the momentum by f dt each substep, exactly, so currents swing to the right in the north and a Kelvin wave keeps its coast;
- `roughness`, Manning's n of the bed.

At an open sea, `tidalLevel(constituents, {mean, ramp})` gives the tide coming in from its harmonic constituents (`{amplitude, speed, phase}`, `speed` in rad/s or a name in `TIDAL_CONSTITUENTS`: M2, S2, N2, K2, K1, O1, P1, Q1, Mf, Mm), for a `{sea}` or `{level}` side. `inverseBarometer(drop, density)` gives the rise under a drop in pressure.

```ts
import {bedSurface} from 'margoengine/physics/earth';
import {ShallowWaterSolver} from 'margoengine/physics/hydro';
import {SurgeSolver} from 'margoengine/physics/surge';
import {PhysicsWorld} from 'margoengine/physics/world';

// Lake Superior on 10 November 1975, as a flat box 563 km by 160 km and 147 m deep at 47.5 N: a 50-knot westerly for ten
// hours and the 982 hPa low crossing it, an hour of the lake each second of the world's.
const columns = 56, rows = 16, width = 563000, depth = 160000, hour = 3600;
const elevations = new Float64Array((columns + 1) * (rows + 1)).fill(-147);
const wind = {
  medium: 'air' as const,
  cell: [0, 0, 0] as const,
  // A field is read at the world's time and says the water's time scale: one world second is an hour of the storm.
  timeScale: hour,
  sample: (_x: number, _y: number, _z: number, t: number, out = {velocity: [0, 0, 0] as [number, number, number], density: 0, temperature: 0}) => {
    out.velocity[0] = 25.7 * Math.tanh((t * hour) / 7200);
    out.velocity[1] = out.velocity[2] = 0;
    out.density = 1.2;
    out.temperature = 280;
    return out;
  },
};
const water = new ShallowWaterSolver();
using surge = await SurgeSolver.load();
const world = new PhysicsWorld()
  .add(water, {
    bed: bedSurface({columns, rows, width, depth, centre: [width / 2, depth / 2]}, elevations),
    level: 0,
    roughness: 0.025,
    wind,
    coriolis: {latitude: (47.5 * Math.PI) / 180},
    timeScale: hour,
  })
  // The pressure is on the water's time: the low moves east at 25 m/s.
  .add(surge, {water, pressure: (x, z, t) => 101325 - 3125 * Math.exp(-(((x + 100000 - 25 * t) ** 2 + (z - depth / 2) ** 2) / 9e10))})
  .couple(['surge', 'water'], 'staggered');
world.advance(10 * world.rate.num / world.rate.den); // ten world seconds: ten hours of the lake
const east = water.sample(width - 5000, depth / 2).surface, west = water.sample(5000, depth / 2).surface;
console.log((east - west).toFixed(1)); // about 0.8: the lake piled up at its eastern end
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

Above 3 m/s Langmuir windrows sweep long-lived foam into lines along the wind. The bounded flux transport stretches a patch under shear. It conserves the unsaturated interior field, with open-domain outflow and explicit saturation at full coverage. Ships lay wakes: white water two beams long at the stern, a turbulent wake widening as x^(1/5) for a ship length, and the bow waves' arms at Kelvin's angle once the hull is fast enough. A wake's foam lasts minutes. The spray the whitecaps throw into the air follows Gong's (2003) flux by the whitecap method, with Troitskaya's bag breakup at strong winds.

Its settings:
- `waves`: the sea, a `WaveSolver` (its `field`, and its friction velocity for the spray) or any `WaveSpectrumField`;
- the grid: `cells` (default 128 by 128) of `cellSize` metres (default 2), about `centre`; `statistics`, the spacing at which the spectrum is read for the breakers (default 64 m);
- `originCellSize`, the world cell size in metres (default 4,096), for relocating sampled wave, current and wind cells;
- `wind`, a framework `Wind`, for the wind drift and the windrows; `current`, a water `FlowField` (a river's or a tide's);
- `decay`, residual foam's e-folding time (default 3.8 s in sea water, 2.5 s in fresh, from the sea's density);
- `windDrift` (default 0.006 of U10); `windrows` (`{spacing = 30, speed = 0.01, spinUp = 300}` or `false`);
- `ships`: `{body, length, beam}` or `{track(t), length, beam}`; `wakePersistence` (default 150 s);
- `bubbles` (default true): the air a damaged hull lets out under water (the `hullBreaches` port of a `HullSolver` with compartments, in the foam's cell) rises as a bubble plume (`bubblePlume`: the integral round plume, entraining at 0.055 with millimetre bubbles slipping at 0.23 m/s and the gas expanding as it rises) and boils at the surface, whitening the water as a propeller race does out to where its radial current (`surfaceCurrent`, Fannelop and Sjoen's, from twice the plume's radius) falls to a twentieth of `WASH_SPEED`;
- `capacity` (breakers alive at once, default 8192) and `rate` (its rate level).

`new FoamSolver()` uses TypeScript transport. `FoamSolver.load()` lazily loads the Rust SIMD flux loop.
Pass `{threads: 2}` or `{threads: 4}` in Node or in a cross-origin-isolated browser worker.
The default is one participant. `signal` cancels loading. Call `dispose()` to release its workers.
`workCounts()` reports the latest accepted transport work and is undefined on a still or scalar tick.

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
const foam = await FoamSolver.load();
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
foam.dispose();
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
- `water`: the `ShallowWaterSolver`, added to the world first. Align its grid with the surf solver. For an incident spectrum in a different cell, match `originCellSize` to the scene (4096 m by default);
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

The water's own `sample` gives the set-up and the currents. The surf advances its energy, roller, forcing and shore marks together. An invalid sample or flux leaves the previously accepted outputs intact and reports a code and a fix. `SurfSolver.load(id?, {threads, signal})` selects optional exact native radiation-stress moments and divergence. One participant is the default. Use Node or an isolated browser worker for two or four. Dispose the loaded solver after the world finishes. `readNativeWork()` gives the accepted cell and direction counts.

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
using surf = await SurfSolver.load();
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

`ShipSolver` holds each ship's rigid body through `bodyForces` with the MMG standard method (Yasukawa and Yoshimura 2015). That gives surge, sway and yaw: the hull's manoeuvring forces, the propeller's thrust in the wake it works in, and the rudder's normal force in the propeller's race, with the added masses and their coupling. The body then turns, drifts and stops as the method's ship does. Couple it before the rigid solver: `world.couple(['ship', 'rigid'], 'staggered')`. With a `HullSolver` floating the hull, use `['ship', 'hull', 'rigid']`. Each force then has one owner. The ship's derivatives hold the hull's surge, sway and yaw damping, and their added mass, so it claims them in the `manoeuvringClaims` port. The hull solver leaves its own radiation and added mass in those rows out, and keeps heave, roll and pitch, the waves' loads and the hull's buoyancy.

Each ship is `{row, model}` and takes these settings:
- `model`: a `ManoeuvringModel` with the particulars, hydrodynamic derivatives and interaction constants. `KVLCC2_L7` is the 7 m KVLCC2 model of the paper, and `scaleModel(model, factor)` Froude-scales it (`scaleModel(KVLCC2_L7, 320 / 7)` is the tanker).
- `midship`, `forward` and `up` in the body's frame (defaults the origin, +X and +Y).
- `rudderRate`: default 2.32 degrees a second, the SOLAS 35-to-30 degrees in 28 s.
- `thruster`: `{diameter, power, position, merit}` for a bow thruster. `merit` is its static merit coefficient C = T^(3/2) / (P sqrt(rho A)) (default 0.82; Beveridge 1971 measured 0.55 to 1.5 on models, 2 the ideal), so its thrust is (C / 2)^(2/3) of the momentum bound `thrusterThrust`; with way on its force and moment fall and rise again as Chislett's captive tests show (`thrusterAhead(U / U_j)`).
- `shaftDepth`: the propeller shaft's depth below the waterline, m (default the draught less 0.52 diameters, KCS's published propeller centre).
- `thrusterOutlet`: `{halfSpan, depth}` in metres from the centreline and below the design waterline. Requires a
  thruster and a depth at least half its diameter. Omit it to keep the tunnel out of the water field.
- `block` and `addedMass`: `addedMass: false` leaves the surge, sway and yaw added mass to a HullSolver's strips (the ship still claims their damping).
- `hull`: the hull's form for `holtropMennen` (`{length, beam, draughtFore, draughtAft, volume, lcb, midship, waterplane, ...}`). Given, the straight run's resistance at each speed is Holtrop and Mennen's, rising with the waves the hull makes, in place of the model's constant R'_0; `revolutionsFor` balances it.
- `autopilot`: `{bandwidth, damping}`, the heading loop's natural frequency in units of U / L (default 1) and its damping ratio (default 0.8).
- `waveHull`: `{pitchGyration, entrance, run}`, the hull as waves see it: k_yy / L (default 0.25) and its waterline's lengths of entrance and run, m (default (1 - C_WP) L each for C_WP = (1 + 2 C_B) / 3, an assumption: give the hull's own, which the short-wave reflection depends on).
- `iceHull`: `{stem, bow, parallel}`, the stem angle (rad) and the lengths of the bow and parallel midbody (m), so the ship breaks the solver's level ice (`ice`).
- `roll`: for a model with `heel`, what holds the ship upright: `'model'` (default) gives the body the model's restoring moment g m GM sin(phi) and roll damping, and needs the world's gravity; `'hull'` leaves them to a HullSolver floating the body.

A model with `heel` rolls as it turns, by Fukui et al.'s (2016) four-degree-of-freedom MMG model: the hull's forces gain heel terms from captive tests at fixed heel, the roll moment about the centre of gravity balances the hull's and rudder's moments against the restoring moment g m GM sin(phi) and the roll damping of the decay test, and the heeled rudder's force carries cos(phi). `heel` is `{metacentricHeight, gravityDepth, gyration, addedInertia, decay, hullDepth, rudderDepth, straightening, surge, sway, yaw, roll}`: GM and the centre of gravity's depth below the water plane are needed, the rest default (k_xx 0.4 B, J_xx 0.2 I_xx, decay coefficient 0.035, the hull's side force at half the draught, the rudder's at its centroid, no heel terms; without `roll` the hull's roll moment is its side force at `hullDepth`). `KCS_MODEL` is the KCS container ship's 2.19 m model with its heel terms at GM 0.60 m full scale, its rudder's roll lever and roll damping fitted to MARIN's measured roll. A high-GM ship such as KVLCC2 barely heels; KCS heels out about 17 degrees as it starts a hard turn, about 5 degrees in the steady turn, and turns about 8 percent tighter for it. Under the solver, sway and yaw act in MMG's horizontal body axes, so a heeled or trimmed hull's forces stay level, and `status(i).heel` and `rollRate` read the body's roll.

```ts
import {KCS_MODEL, Manoeuvring} from 'margoengine/physics/ship';

// KCS's model at Fn 0.26 (24 kn full scale), GM 0.60 m, hard over: it heels out about 17 degrees as it starts to turn.
const kcs = new Manoeuvring(KCS_MODEL, {u: 1.206}, {rudderRate: ((2.32 * Math.PI) / 180) * Math.sqrt(105)});
kcs.revolutions = kcs.selfPropulsion(1.206);
kcs.order = (35 * Math.PI) / 180;
let most = 0;
while (kcs.time < 10) {
  kcs.step(0.01);
  most = Math.min(most, kcs.state.heel ?? 0);
}
console.log(Math.round((-most * 180) / Math.PI)); // 17
```

In water under ten draughts deep, `shallowWater(model, depth)` gives the model the ship runs on there (the solver does this itself from `depth`), held at h/T 1.2 below that. A model with its own `shallow` table, from captive tests at several depths, uses it. KVLCC2's table is `KVLCC2_SHALLOW`, and `KVLCC2_L7` carries it. A table holds the hull's Y'v, N'v and N'r, its surge derivatives and resistance, and its hull, propeller and rudder interaction constants, each as `[h/T, ...values]` rows interpolated in (T/h)^2. A model without a table takes Ankudinov et al.'s (1990) factors on its hull derivatives. KVLCC2 at 7 kn then overshoots a 20/5 zigzag 3.8 degrees at h/T 1.2, as KRISO measured. Measured against data not fitted, it is within 20 percent of KRISO's and FHR's other zigzags and turns at h/T 1.2. At h/T 1.5 its 20/5 overshoot is 45 percent under KRISO's (docs/limits.md).

```ts
import {KVLCC2_L7, Manoeuvring, shallowWater} from 'margoengine/physics/ship';

// KVLCC2's model at 7 kn full scale in water 1.2 draughts deep: a 20/5 zigzag's first overshoot.
const speed = (7 * 0.514444) / Math.sqrt(320 / 7);
const ship = new Manoeuvring(shallowWater(KVLCC2_L7, 1.2 * KVLCC2_L7.draught), {u: speed}, {
  rudderRate: ((2.32 * Math.PI) / 180) * Math.sqrt(320 / 7),
});
ship.revolutions = ship.selfPropulsion(speed);
ship.order = (20 * Math.PI) / 180;
let overshoot = null;
while (overshoot === null) {
  ship.step(0.05);
  if (ship.order > 0 && ship.state.heading > (5 * Math.PI) / 180) ship.order = -ship.order;
  if (ship.order < 0 && ship.state.r < 0) overshoot = (ship.state.heading * 180) / Math.PI - 5;
}
console.log(overshoot.toFixed(1)); // 3.8
```

The solver also takes `depth` (a number or a function of (x, z): for squat, and for shallow water), `walls` (quays and banks, `{from, to}`), `density` and `ice: {thickness}` (level ice, m, a number or a function of (x, z), 0 for open water). With `waves`, regular `{amplitude, period, direction}` or irregular `{significantHeight, period, direction, spread}` (the direction the waves travel, rad on the ground plane; a Bretschneider spectrum in the significant height and mean period, spread as cos^spread), each ship meets their mean drift loads as Yasukawa (2006) adds them to the MMG forces: the surge force by the ITTC's SNNM added resistance (Liu and Papanikolaou; `addedResistance`), the sway force and yaw moment by the short-wave reflection on the waterline facing the waves times Fujii and Takahashi's draft factor (`driftLoads`, `irregularDriftLoads`). In head seas it slows, and in a turn it drifts down the waves; `status(i).forces.XW`, `YW` and `NW` read them. The wave-frequency heave, roll and pitch are a HullSolver's on the same sea. A ship with an `iceHull` going ahead through level ice is held back by Riska et al.'s (1997) regression of Baltic full-scale trials (`iceResistance(hull, thickness, speed)`: a breaking part C1 and a part C2 growing with speed); stopped, the ice holds it up to C1, and `status(i).ice` reads the force. Broken floes are ICE-04's: give the same body to a `PackIceSolver` as a vessel and couple `['ship', 'pack-ice', 'rigid']`, and the ship and floes push each other. A wall alongside, within half a ship length of the midship along it, pushes the ship by Vantorre et al.'s (2003) regression of captive tests (`bankLoads`): toward the bank and bow away at usual depths, off it in very shallow water (below h/T about 1.2), and the propeller ahead draws the stern in; `status(i).suction` and `bankMoment` read the force and moment, and `bankInRange` whether the hull is in the regression's range. Where the water is under ten draughts deep, each ship runs on its model corrected for the depth (`shallowWater(model, depth)`): every hull derivative and the sway and yaw added masses by Ankudinov et al. (1990), the surge added mass by Li and Wu (1990), held at h / T 1.2 below that; the model is made again when the draught over depth moves by a hundredth. A ship then turns wider as the water shoals, as ships do.

Steer with `control(i)`:
- `revolutions`, rev/s, negative astern; `revolutionsFor(i, speed)` gives the self-propulsion revolutions;
- `rudder`, the order in radians, positive to starboard;
- `thruster`, from -1 to 1;
- `heading`, radians on the ground plane from +X toward +Z (the way the ship turns to starboard), or null: the autopilot holds it;
- `speed`, m/s through the water, or null: the telegraph sets the revolutions that hold that speed against the calm water's resistance and the last step's added resistance from waves and ice, trimmed by the speed's error while the ship gathers way, in place of `revolutions`;
- `track`, `{waypoints: [[x, z], ...], lookahead, acceptance, loop}`, or null: the autopilot follows the waypoints by line of sight (Breivik and Fossen 2008), with a lookahead of 5 ship lengths and waypoints passed within 1 ship length along the track by default.

The autopilot places the poles of the ship's own manoeuvring model, linearised in sway and yaw at its speed (`Manoeuvring.linearize`), with an integral of the heading error, so a course-unstable hull such as KVLCC2 holds its heading and a steady wind leaves no offset. It eases into a new heading through a second-order reference at its own frequency, places its gains again when the speed changes by a tenth, and on a track crabs into a steady drift low-passed over 10 L / U. `status(i)` then gives its `heading`, `headingOrdered` and `track` (`leg`, `course`, `crossTrack`, positive to starboard of the leg, and `done`).

`status(i)` reads speed, drift, yaw rate, rudder angle, the forces, the squat, the thruster's push and the quay's pull. `workCounts()` reads the last step's work: ships stepped, MMG force evaluations, irregular-sea drift tables built, walls tested and shallow-water models made, deterministic counts that grow with the fleet; the `PlaningSolver`, `RowingSolver` and `SailingSolver` count their boats and wetted strips, blades in the water, and yachts and sail plans. Every refusal of the ship entry is a coded `MargoError` (`unsupported`) whose message names the fix and links to margoengine.com/errors#ships.

What it gives the rest of the engine:
- `sea(base)`: the sea drawn down along each hull by its squat (ICORELS and Hooft's form of Tuck's law, Huuska's factor in a channel). Pass it to the `HullSolver` as its sea, so the hull sinks and trims by its own hydrostatics and the drawdown shows. `drawdown(x, z)` reads it.
- `water`: a water `FlowField` of propeller races and configured tunnel jets, for foam, bubbles, the bed and divers.
  The tunnel discharges on the side opposite its thrust and follows the rigid hull. Its unconfined flow uses a
  momentum-normalized Gaussian based on Albertson et al.'s round jet, with no quay or bed-reflection term.
- `sources(t)`: each hull's draught pressed on the surface, for a `WakeSolver` (`sources: (t) => ships.sources(t)`), so it makes a bow wave and a Kelvin wake.
- `wash(t)`: where each race boils up to the surface, for a `FoamSolver` ship's `wash`, so the stern boils white even at the quay.
- The bow thruster: its ideal thrust (4 rho A)^(1/3) P^(2/3) times 0.55, falling to half near a speed of 0.4 of the jet's and recovering beyond.
- Suction toward a quay or bank alongside: the return flow squeezed through the gap.
- Bank effects (`bankLoads`): a bank or quay alongside draws the ship in and turns its bow away, and in very shallow water pushes the bow off, by Lataire's model fitted to Vantorre et al.'s captive tests; `status(i).bankInRange` says whether the ship is within the fitted depths and speeds.

Any hull, not only KVLCC2: `empiricalModel({length, beam, draught, block, trim, centre, propeller: {diameter}, rudder: {area, span}})` builds the MMG model from the hull's dimensions:
- Kijima's (1990) linear derivatives, and for a full hull (C_B 0.7 and above) his nonlinear ones in their own v'|v'| form;
- Yoshimura and Masumoto's (2011) cubic terms for a fine hull, with their surge terms, trim corrections and rudder interaction set;
- Clarke's and Brix's added masses, and R'_0 by the ITTC-1957 line with Holtrop's form factor.

`range` says where the hull lies against the regressions' databases. A Great Lakes freighter at L/B 9.5 lies outside them, and is an extrapolation.

The race is resolved: `water` gives the axial jet together with:
- the swirl the torque puts into it (Kelvin's circulation on the stream surfaces, falling as x^-2 in the established jet);
- the helical tip vortices with Lamb-Oseen cores, holding to 0.8 D and gone by 1.5 D, and the hub vortex;
- the rudder jet, turned by the rudder's side force over the race's momentum flux.

`status(i).cavity` says whether the tip vortices cavitate: the tip's cavitation number against the core's inception index, with hysteresis (a cavity formed in gassy water holds until desinence, `gas` per ship), and its radius. `aeration(t)` gives the air the cavities carry off where the vortices break down, for the bubbles and the foam. Pass `blades` per ship (default 4).

On their own: `resolvedRace(race, point)`, `raceNumbers`, `inceptionIndex`, `cavityRadius`, `coreDeficit`, `VortexCavity` and `collapseTime`.

The parts work on their own too:
- `Manoeuvring`: the MMG ship stepped by Runge-Kutta, with `selfPropulsion(speed)`; with a model's `heel` it carries `state.heel` and `state.rollRate`, and `forces().K` is the hull's and rudder's roll moment about G.
- `Propeller`: open-water K_T and K_Q, four quadrants by Healey's lift and drag fitted to the curves, and the race's far-wake speed. `raceVelocity(race, point)` is the jet's velocity at a point.
- Four quadrants from measurement: give a propeller's curves `fourQuadrant` (C_T* and C_Q* Fourier coefficients in the advance angle) and its thrust and torque in every quadrant, astern and windmilling included, come from them in place of Healey's idealisation; `B4_70_FOUR_QUADRANT` is the Wageningen B4-70 at P/D 1.0 (NSWC's fit of MARIN's tests), for example `{...bSeriesCurves({blades: 4, area: 0.7, pitch: 1}), fourQuadrant: B4_70_FOUR_QUADRANT}`; `fourQuadrantCoefficients(table, beta)` evaluates one.
- `wageningenB({blades, area, pitch, reynolds}, J)`: a Wageningen B-series propeller's K_T and K_Q by Oosterveld and van Oossanen's (1975) polynomials, with their Reynolds correction; `bSeriesCurves(propeller)` fits MMG's quadratic curves to them from bollard pull to zero thrust, for a model's `propeller.curves`.
- `savitsky(hull, speed, water)`: a prismatic planing hull running steady by Savitsky's (1964) equations: its trim, mean wetted length, the keel's and chine's wetted lengths, the normal force at his centre of pressure, the bottom's friction and the thrust and resistance, with the thrust line's depth and angle (`{beam, deadrise, mass, lcg, vcg, thrustDepth, thrustAngle}`); `planingLoads(hull, trim, lambda, speed)` is the bottom's loads at a given attitude.
- `holtropMennen(hull, speed)`: Holtrop and Mennen's resistance with the wake fraction, thrust deduction and eta_R; `ittc1957(Re)` is the friction line.
- `squat`, `icorels` and `huuska`, `rudderLiftSlope` (Fujii) and `thrusterThrust`.

Planing boats run on rigid bodies under a `PlaningSolver`: each boat's prismatic bottom (`{row, beam, deadrise, length, transom, forward, up, propeller, thrustAngle}`) is cut into strips across the keel, each a wedge entering the water by Zarnick's (1978) momentum theory: the rate of change of its added mass's momentum, its cross-flow drag and its buoyancy, the added masses moved to the left of the heave and pitch equations, falling to nothing at the transom by Garme's function. The body rises, trims and runs at its own attitude, and porpoises where a real boat does. Set `control(i).thrust`, read `status(i)` (trim, immersion, speed, normal force, friction, wetted lengths, resistance, airborne). Couple it before the rigid solver and give it the rigid solver's `level` (its fixedTimestep's: a 1 m model wants 1/480 s); the world needs gravity. Surge, heave and pitch only.

Rowing boats run under a `RowingSolver`: each oar (`{pin, side, outboard, area}`, its pin in the body's frame, 1 starboard or -1 port, the pin-to-blade-centre length and the blade's area, default the Macon blade's 0.108 m^2) sweeps from its catch to its finish angle in the drive with a half-cosine sweep and back in the recovery, and its blade takes the lift and drag Caplan and Gardner measured on a Macon blade (`bladeCoefficients(alpha)`), from when it starts to move aft through the water to when it would move forward again. The crew (`crew`, kg, part of the body's mass) moves fore and aft by `travel` (default 0.6 m) each stroke, and the hull's `drag` (k for k v^2, or a function of the speed) acts at the hull's own speed. Set `control(i)`: `rate` (strokes a minute), `drive` (s), `catchAngle` and `finishAngle` (rad, 0 square to the hull, negative toward the bow) and `turn` (-1 to 1, shortening one side's sweep to turn); `status(i)` reads the phase, the oars' angle, the speed and the hull's, the blades' push and the rowers' power.

```ts
import {Physics} from 'margoengine/physics';
import {RowingSolver} from 'margoengine/physics/ship';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

// A men's single scull at 35 strokes a minute from a standing start (pitch and roll held: nothing floats it here).
await Physics.load();
const physics = new Physics(null, {fixedTimestep: 1 / 240, gravity: [0, 0, 0]});
const shell = physics.addBody(null, {enabledRotations: [false, true, false], colliders: {shape: 'box', halfExtents: [4, 0.2, 0.2], mass: 103}});
const rowing = new RowingSolver();
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(rowing, {boats: [{row: shell.row, crew: 85.8, drag: 3.19, oars: [
    {pin: [0, 0.2, 0.8], side: 1, outboard: 1.8, area: 0.08},
    {pin: [0, 0.2, -0.8], side: -1, outboard: 1.8, area: 0.08},
  ]}], level: 2})
  .couple(['rowing', 'rigid'], 'staggered');
Object.assign(rowing.control(0), {rate: 35, drive: 0.85, catchAngle: (-62 * Math.PI) / 180, finishAngle: (43.5 * Math.PI) / 180});
world.advance(60 * 30);
console.log(shell.position[0] > 100); // true: well under way
```

Sailing yachts: `yachtWater(hull, speed, heel, leeway)` is a yacht's water forces by the Delft Systematic Yacht Hull Series (Keuning and Katgert's 2008 upright residuary resistance, Keuning and Sonnenberg's 1998 heel, keel, side force and effective span), `yachtSails(rig, awa, aws, heel, flat, reef)` its mainsail's and jib's forces by the ORC's 2023 tables in the heeled rig's plane (a jib larger than the foretriangle, `rig.headsail` m^2, blanketed past 135 degrees by its overlap; `downwind` for the ORC's jib downwind set), and `velocityPrediction(hull, rig, tws, twa)` balances them into its steady speed, heel and leeway, flattening the sails for speed and depowering past `maxHeel` (default 30 degrees); from 60 degrees of true wind it also sails the jib downwind set and keeps the faster (`run.downwind`), as the ORC's No Spinnaker configuration does. The hull is the DSYHS's parameters (`{length, beam, draught, volume, waterplane, lcb, lcf, prismatic, midship, keel, rudder}`, LCB and LCF from the bow) and the rig `{I, J, P, E, boom, freeboard, mass, metacentricHeight}`. Under a `SailingSolver` (`{yachts: [{row, hull, rig}], wind}`, the wind a velocity or a flow field of air) the yacht sails on its rigid body: the keel's side force at its centre of lateral resistance and the sails' force at their centre of effort heel it against g m GM sin(phi) (or a HullSolver's, `roll: 'hull'`), and the helm holds `control(i).heading`. Leave out `rig` and give `metacentricHeight` when the sails are another solver's, such as AERO-02's `SailForce` on a cloth lashed to the mast.

```ts
import {velocityPrediction} from 'margoengine/physics/ship';

// The YD-41 reaching across 12 knots of true wind: about 8.8 kn (its ORC certificate: 8.60 kn).
const hull = {length: 11.9, beam: 3.18, draught: 0.4, volume: 6.05, waterplane: 26.8, lcb: 6.44, lcf: 6.82, prismatic: 0.56, midship: 0.72,
  keel: {draught: 2.3, volume: 0.25, root: 1.6, tip: 0.9, thickness: 0.12, centre: 0.9}, rudder: {area: 0.9, chord: 0.6, thickness: 0.12}};
const rig = {I: 16.2, J: 5.1, P: 16.7, E: 5.6, boom: 1.8, freeboard: 1, mass: 6200, metacentricHeight: 2.5};
const run = velocityPrediction(hull, rig, 12 * 0.514444, Math.PI / 2);
console.log((run.speed / 0.514444).toFixed(1)); // 8.8
```

```ts
import {savitsky} from 'margoengine/physics/ship';

// Shoemaker's planing model 29 (b 16 in, deadrise 20 degrees, 80 lb) at 18 kn in fresh water: trim 4.2 degrees and 14.7 lb
// of drag, where the tank measured 4.0 degrees and 15.2 lb.
const lb = 4.4482216, inch = 0.0254;
const run = savitsky({beam: 16 * inch, deadrise: (20 * Math.PI) / 180, mass: (80 * lb) / 9.81, lcg: 18.5 * inch}, 18.01 * 0.514444,
  {density: 999, viscosity: 1.14e-6, gravity: 9.81, roughness: 0});
console.log(((run.trim * 180) / Math.PI).toFixed(1), (run.resistance / lb).toFixed(1)); // 4.2 14.7
```

```ts
import {addedResistance, irregularDriftLoads} from 'margoengine/physics/ship';

// KVLCC2 at 15.5 kn in head waves 1.2 ship lengths long: 747 kN per metre squared of wave amplitude.
const kvlcc2 = {length: 320, beam: 58, draught: 20.8, block: 0.81};
const omega = Math.sqrt((2 * Math.PI * 9.81) / (1.2 * 320));
console.log(Math.round(addedResistance(kvlcc2, 1, omega, 0, 7.97) / 1000)); // 747
// In a 4.4 m, 10.6 s sea from ahead (cos^4 spread) at 6.7 m/s: about 1.1 MN.
const sea = {significantHeight: 4.4, period: 10.6, direction: Math.PI, spread: 4};
console.log(Math.round(-irregularDriftLoads(kvlcc2, sea, 0, 6.7).X / 1000)); // 1132
```

```ts
import {iceResistance} from 'margoengine/physics/ship';

// MT Uikku (150 m) at 0.5 m/s through 0.76 m of level ice: about 640 kN (the Aalto basin measured 560 kN, +-120).
const uikku = {length: 150, beam: 21.3, draught: 9.5, stem: (30 * Math.PI) / 180, bow: 39, parallel: 65};
console.log(Math.round(iceResistance(uikku, 0.76, 0.5).resistance / 1000)); // 639
```

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
// The autopilot brings her back to +X and holds it.
ships.control(0).heading = 0;
world.advance(60 * 260);
console.log(Math.abs(ships.status(0).heading) < 0.01); // true
```

```ts
import { Physics } from 'margoengine/physics';
import { KVLCC2_L7, ShipSolver } from 'margoengine/physics/ship';
import { PhysicsWorld, RigidSolver } from 'margoengine/physics/world';

await Physics.load();
const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] });
const body = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [3.5, 0.46, 0.635], mass: 1025 * KVLCC2_L7.volume } });
const ship = new ShipSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics }).add(ship, {
  ships: [{ row: body.row, model: KVLCC2_L7, thruster: { diameter: 0.2, power: 5, position: 2 },
    thrusterOutlet: { halfSpan: 0.43, depth: 0.45 } }],
}).couple(['ship', 'rigid'], 'staggered');
ship.control(0).thruster = 1;
world.advance(1);
console.log(ship.water.sample(2, -0.45, -0.7, 1 / 60).velocity[2] < 0); // true, toward port
```

### Loads in the water (`@margoengine/physics/loads`)

`LoadSolver` holds rigid bodies in the water through `bodyForces` with the water's loads (SEA-12): divers, debris, buoys, hoses, piles and dolphins. The default `loads` and `rigid` solvers are ordered automatically. If you rename or compose the solvers, put loads before rigid in a staggered group with `world.couple([loadId, rigidId], 'staggered')`.

#### Float any body in one call (`floating`)

`await floating(physics, bodies, options?)` reads each body's own colliders and returns the `LoadSolver` bodies that
float it, so buoyancy, drag and the righting moment come from the same shapes as its contacts and its mass, and the waves
it makes damp its heave and roll. A boat of a box hull and a mast rides at its Archimedes draft:

```ts
import { Physics } from '@margoengine/physics';
import { floating, LoadSolver } from '@margoengine/physics/loads';
import { SpectralSea } from '@margoengine/physics/sea';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';
await Physics.load(); const physics = new Physics(null, { fixedTimestep: 1 / 60 });
const boat = physics.addBody(null, { position: [0, 0.04, 0], colliders: [{ shape: 'box', halfExtents: [1, 0.2, 0.5], density: 400 }, { shape: 'cylinder', radius: 0.05, halfHeight: 0.6, offset: [0, 0.8, 0], density: 400 }] });
const sea = new SpectralSea({ waves: { frequencies: Float64Array.of(1), directions: Float64Array.of(0), energy: new Float64Array(1), depth: 20, density: 1000 } });
new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics }).add(new LoadSolver(), { sea, bodies: await floating(physics, boat, { sea }) }).advance(600);
console.log(Math.abs(boat.mass / 1000 / 2 - (0.2 - boat.position[1])) < 0.003); physics[Symbol.dispose](); // true: draft = mass / (rho A)
```

- **Every solid collider:** a sphere, box or capsule (any axis) floats as its analytic shape at the collider's offset
  and turn; a convex hull (its own faces) and a closed triangle mesh are integrated exactly below the water; a cylinder
  or a cone is a 64-sided prism or pyramid (`FLOATING_SIDES`) whose radius keeps the circle's area, so its displaced
  volume is exact and its waterplane's second moment is within 1e-6 of the circle's. A compound (and a convex
  decomposition) gives one entry a part: the body's buoyancy is the sum of its parts', as its mass is.
- **Skipped and refused:** sensors and disabled colliders displace nothing. A half space, height field, voxel grid,
  segment, triangle or polyline has no closed volume, and a rounded collider (border radius above 0) floats only as its
  core: each is a MargoError `unsupported` ([errors#hydrodynamic-loads](https://margoengine.com/errors#hydrodynamic-loads))
  naming the fix, as is a body of another `Physics`.
- **Options:** `drag`, `spinDrag`, `windage` and `addedInertia` go on every entry, as the `LoadBody` fields of the same
  name (defaults: the shape's own drag by Reynolds number, `spinDrag` 1, the shape's own windage, no rotational added
  inertia). `pressureModel: 'surface'` (default `'compact'`, the local water plane) integrates the water's incident
  pressure over every box, hull, mesh, cylinder and cone entry, so a wave shorter than the body heaves and pitches it
  (spheres and capsules have no surface tier and stay compact; the sea needs a `pressure`). The colliders are read at
  the call; call `floating` again for a new solver after a collider changes.
- **Waves it makes (`radiation`):** a moving float makes waves that carry its energy away, so a dropped body's heave and
  roll die out. Each wet part is panelled at its own shape and the SEA-08 panel method (`bakeHullPanels`, linear
  potential flow with the free-surface Green function) gives its 6 x 6 added mass and damping at the body's still-water
  draft, in its attitude at the call; the coupled passive fit (Cummins 1962; Perez and Fossen 2008) becomes the body's
  `coupledRadiation`. `'fast'` (default): about 80 wet panels and 12 frequencies, a few seconds a body; `'fine'`: about
  320 panels and 24 frequencies, a minute or two; `'none'`: the shape's deep-water added mass and no waves (and the only
  tier that takes `addedInertia`). Validated on Kramer et al.'s (2021) measured sphere: the fine tier's damped period is
  within 0.2 % of the measured 0.76 s and its heave coefficients within 2 % of WAMIT's; the fast tier within 1 % and 6 %
  (`tests/loads-floating-radiation.test.js`). Pass `sea` so the bake uses the water's density (default 1025 kg/m³), and
  `gravity` when the world's is not 9.81; `signal` stops a bake. Every body bakes on its own: for many identical crates,
  float one and give its twins its entries with their own `row` (`{ ...entry, row: twin.row }`).
- **No energy from the step:** the displaced water is taken at the pose the rigid step makes energy-neutral, (s - 1) /
  (2 s) of the step on for its s substeps, so an undamped float heaves and rolls at constant amplitude at 60 steps a
  second (it grew 20 % a cycle when taken at the step's start, KB-LOADS-HEAVEGAIN1).
- **Any water:** `sea` is a `SpectralSea`, a flood's surface or, through `seaSurface` from `@margoengine/water/sea-state`,
  the `Water`, `FFTOcean` or pointer `Ripples` the camera sees.
- **What it found:** `loads.bodyLoad(i)` gives entry `i`'s last step: `submerged` volume (m³) and `wet` fraction, the
  shape's `centre`, the `centreOfBuoyancy` (the displaced volume's centroid below the local water plane), `depth` (the
  water above the centre), `buoyancy` (N) and `force`, the water's other loads before the added-mass hold (Froude-Krylov,
  the water's acceleration on the added mass, drag and windage).
- **Debug view:** `loads.debugRender(options)` gives line segments for `PhysicsDebugView.add(loads)`
  (`@margoengine/physics/debug-view`): each body's edges below the water (blue), its waterline on the water as it is now
  (white), its centre of buoyancy (magenta cross), its buoyancy (cyan) and the other loads (orange). Options, all default
  true: `submerged`, `waterline`, `centreOfBuoyancy`, `forces`; `forceScale` in metres per newton (default each body's own,
  so its full buoyancy draws twice the cube root of its volume long).

```ts
import { Physics } from '@margoengine/physics';
import { floating, LoadSolver } from '@margoengine/physics/loads';
import { SpectralSea } from '@margoengine/physics/sea';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';
await Physics.load(); const physics = new Physics(null, { fixedTimestep: 1 / 60 });
const buoy = physics.addBody(null, { colliders: { shape: 'cylinder', radius: 0.4, halfHeight: 0.5, density: 300 } });
const sea = new SpectralSea({ waves: { frequencies: Float64Array.of(1), directions: Float64Array.of(0), energy: new Float64Array(1), depth: 20, density: 1000 } });
const loads = new LoadSolver();
new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics }).add(loads, { sea, bodies: await floating(physics, buoy, { radiation: 'none' }) }).advance(1);
console.log(loads.bodyLoad(0).wet, loads.debugRender().vertices.length > 0); physics[Symbol.dispose](); // 0.5 true
```

#### Direct a floating scene (`waveHit`, `ballast`, `impulses`)

Three tools steer floating bodies for a shot through the physics, not around it:

- **`waveHit({at, time, crest, period?, direction?, peakedness?, background?, seed?, components?, sea?, density?})`**
  places a crest `crest` m high at `at` [x, z] at `time` s: a NewWave focused group (Tromans, Anaturk and Hagemeijer 1991)
  of a JONSWAP spectrum with peak `period` (default 8 s, `peakedness` 3.3), travelling along `direction` (default
  [1, 0]), from 64 `components`. With `background` (a significant height, default 0) it is a random sea of that
  spectrum, `seed` (default 1), constrained to make the same crest there and then (Taylor, Jonathan and Harland 1997).
  It is a linear deep-water sea (Airy orbits and pressure) on top of `sea` (default still water), so it is a
  `LoadSolver` `sea`, and `waveComponents` gives `Water` the same waves to draw (`new Water({sea: hit})`).
- **`ballast(mesh, {draft, heel?, trim?, height?, density?})`** gives the `mass` and `centerOfMass` that float a closed
  mesh (the body's hull in its frame) at that draft (its lowest point below the water, m), heel (about X) and trim
  (about Z), with its centre of mass at `height` (default the centroid's), and the pose's `stability` (GM in heel, m).
  The weight is the water displaced there and the centre of mass sits over the centre of buoyancy, so the pose is an
  equilibrium of the same buoyancy; a pose that would capsize is a MargoError naming the fix.
- **`impulses: [{row, time, impulse, point?}]`** in the `LoadSolver`'s params pushes a body by `impulse` N s in the step
  that holds `time`, at `point` (default its centre of mass), held with the water it carries; placed by the tick, so a
  replay or a restored snapshot pushes at the same step.

```ts
import { Physics } from '@margoengine/physics';
import { ballast, floating, LoadSolver, waveHit } from '@margoengine/physics/loads';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';
await Physics.load(); const physics = new Physics(null, { fixedTimestep: 1 / 60 });
const hull = { vertices: [-1, -0.4, -0.5, 1, -0.4, -0.5, 1, 0.4, -0.5, -1, 0.4, -0.5, -1, -0.4, 0.5, 1, -0.4, 0.5, 1, 0.4, 0.5, -1, 0.4, 0.5], indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2] };
const boat = physics.addBody(null, { position: [0, 0.1, 0], colliders: { shape: 'box', halfExtents: [1, 0.4, 0.5] } });
boat.setMassProperties(ballast(hull, { draft: 0.3, height: -0.2 }));
const sea = waveHit({ at: [0, 0], time: 5, crest: 0.8, period: 6 });
new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics }).add(new LoadSolver(), { sea, bodies: await floating(physics, boat, { sea, radiation: 'none' }), impulses: [{ row: boat.row, time: 2, impulse: [400, 0, 0] }] }).advance(300);
console.log(boat.position[0] > 0, Math.abs(sea.elevation(0, 0, 5) - 0.8) < 1e-9); physics[Symbol.dispose](); // true true
```

A live page floats boxes, a capsule, a hull and a glTF model on the ocean and in pointer ripples, with this debug view:
[examples/floating.html](../../examples/floating.html).

#### Float a rigid body

Add LoadSolver once to a world with the default RigidSolver, giving each body's row and wetted shape.
Use a SEA-02 SpectralSea or the live SEA-04 nearshore surface for the water input. This still spectrum
makes the sphere's initial buoyant rise easy to check.

```ts
import { Physics } from '@margoengine/physics';
import { LoadSolver } from '@margoengine/physics/loads';
import { SpectralSea } from '@margoengine/physics/sea';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';
await Physics.load(); const physics = new Physics(null, { fixedTimestep: 1 / 60 });
const body = physics.addBody(null, { position: [0, -0.35, 0], colliders: { shape: 'sphere', radius: 0.3, mass: 60 } });
const sea = new SpectralSea({ waves: { frequencies: Float64Array.of(0.8, 1), directions: Float64Array.of(0, Math.PI), energy: new Float64Array(4), depth: 10, density: 1000 } });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics });
world.add(new LoadSolver(), { sea, bodies: [{ row: body.row, shape: { sphere: 0.3 } }] }).advance(1); console.log(body.linearVelocity[1] > 0); physics[Symbol.dispose](); // true
```

The interactive example shows the sphere rise and a heeled box right itself. Use the time slider to replay either motion. [Open the buoyancy demo](https://margoengine.com/demos/buoyancy.html)

#### Migrate buoyancy from a water demo or a physics plugin

Register a box or capsule with the dimensions of its rigid collider. For a hull, register the
closed triangulated wetted surface as a mesh. LoadSolver uses displaced volume and its centroid
for the righting torque and computes viscous spin drag separately from translational form drag.
[Buoyancy migration guide](../../docs/physics-buoyancy-migration.md)

#### Load options

- **Compact bodies** (`bodies: [{row, shape}]`): a shape is `{sphere}`, `{ellipsoid}`, `{box}`, `{capsule: {radius, halfHeight}}` or `{mesh}`. A capsule is centred at the body's local origin by default. Its straight section runs along local Y, with the hemisphere centres at `±halfHeight`. Both dimensions are in metres and `halfHeight: 0` gives a sphere. A mesh needs a closed surface with outward-wound triangles and may split vertices at coincident seams. Each body takes:
  - buoyancy at the displaced volume's centroid, which produces a righting moment. The local sea height sets the horizontal cut. Boxes and meshes integrate pressure on clipped triangles. Spheres and ellipsoids use their exact cap. A capsule clips circular sections at the water plane, integrates their area and first moment, and uses bounded Gauss–Legendre quadrature on partially wetted intervals. The Froude–Krylov force uses the water's acceleration;
  - `pressureModel: 'surface'` reads incident gauge pressure from `sea.pressure` for a box or closed mesh and integrates its wrench over the actual clipped waterline. The default `'compact'` uses the local plane and point acceleration. Additional `flows` still contribute their own acceleration;
  - added mass per axis from Lamb's ellipsoid integrals, held implicitly so light bodies stay stable;
  - rotational added inertia with `addedInertia: 'ellipsoid'` or three measured m² per displaced kg values along the shape axes. The default is zero. `radiation` supplies passive Cummins modes as `{axis, strength, decayTime}`. A mode contributes `strength * exp(-t / decayTime)` to the radiation kernel. `radiationResonances` supplies band-pass modes as `{axis, strength, frequency, decayRate}`. Axes 0–2 are translation and 3–5 are rotation. Both lists default to empty. Use the same fixed world rate throughout the load group and coefficients for the body and draft;
  - drag on the actual principal projections, from Morrison's sphere correlation or the Hölzer–Sommerfeld shape law, with optional `drag` coefficients. A capsule uses its circular and stadium projections for drag and its second-moment-equivalent ellipsoid for default added mass and optional rotational added inertia;
  - independent rotational viscous torque. `spinDrag` scales it, default 1;
  - windage at the area centroid of the emerged silhouette. `windage` overrides the shape- and Reynolds-dependent coefficient.
- **Members** (`members: [{from, to, diameter, row?}]`): Morison's equation over the clipped wetted length. Set `period` to the dominant harmonic in seconds (default 8) or `Infinity` for steady water. The default `coefficients: 'dnv'` uses the peak orbital speed with DNV and White for roughness (`roughness`, default 5e-5 m) and Reynolds effects. `coefficients: 'sarpkaya-1976'` uses a smooth cylinder (roughness 0) and measured in-line coefficients over the laboratory range. A member takes Eames's tangential drag, and with `vortex: {strouhal, lift}` sheds vortices through Facchinetti's wake oscillator, its lift swinging at St U / D. A member on no `row` is fixed, a pile, and `memberLoad(i)` reports what it takes.
- **The water** (`sea`): a `SeaSurface`, or any `{elevation, water, density}` such as a flood's (`{elevation: (x, z) => shallow.sample(x, z).surface, water: shallow.flow, density: 1000}`). Add `flows` for currents and races (`ShipSolver.water`) and `wind` for windage.

The sea, current and wind can use separate origin cells. Set `cellSize` to the PhysicsWorld cell length
if it differs from the default of 4096 m. World-fixed members use the LoadSolver's origin cell.

The capsule section moments follow the circular segment formulas in Gere, *Mechanics of Materials*, 6th ed., appendix D
([2004](https://ndl.ethernet.edu.et/bitstream/123456789/55906/1/128.pdf)). The integration uses the
[NIST Digital Library of Mathematical Functions, §3.5(v)](https://dlmf.nist.gov/3.5.v) Gauss–Legendre rule.

Set `vortexCoupling: 'body-acceleration'` on a circular member attached to a dynamic rigid row
in a nearly uniform steady current. The wake follows the member midpoint's transverse acceleration,
including rotation. Its coherent lift acts through the wetted interval centre. `memberLoad(i).lift`
reports the vortex lift coefficient. The default vortex remains free shedding. Keep the shedding
frequency below half the common world rate.

```ts
import type {LoadMember} from 'margoengine/physics/loads';

const member = {
  row: 0, from: [0, 0, -0.5], to: [0, 0, 0.5], diameter: 0.08, period: Infinity,
  vortexCoupling: 'body-acceleration',
} satisfies LoadMember;
console.log(member.vortexCoupling); // body-acceleration
```

Use `await LoadSolver.load({id, signal})` for the optional Rust SIMD wrench batch. It uses the containing
world's plain or shared memory. It batches the ordinary 32-word rows and six-axis 41-word rows
separately, with one call for each active layout. The synchronous constructor uses the TypeScript
reference. `workCounts()` reports held bodies, native calls and reserved scratch bytes.
`LoadSolver` and the SIMD batches use the same projected dry mobility `D` when holding added-mass and
rotational loads. They solve `(I + A D) held = wrench`, where `A` is water inertia. A locked body axis
can carry reaction force or torque while its corresponding acceleration stays zero.
For a checkpoint from before this field was added, set `readMobility: false` on
`new LoadSolver('loads', {readMobility: false})` or `LoadSolver.load({readMobility: false})` along with
`publishMobility: false` on the rigid solver. Set the same option on the drag adapters used by that checkpoint.

`radiationProfile(mesh, {mass, density, centre})` computes coefficients at the hull's still-water draft.
Its default reference is deep-water strip theory. Select `panels: {frequencies, depth}` for the native
three-dimensional reference. Use the returned `addedMass`, `addedInertia` and
`radiationResonances: profile.resonances` on the same mesh in the loads solver.
`frequencyResponse` reports the sampled band and the fit error in each principal motion.

`coupledRadiationProfile` keeps cross-motion inertia and damping from the full 6×6 panel response.
Choose it for hulls where heave and pitch, or sway and roll, interact. Pass the result as `coupledRadiation`
on the matching `LoadBody` and use that body's local rigid centre of mass and water density. It supplies
its own added inertia and memory. It models small wave motions at zero forward speed.

```ts
import {coupledRadiationProfile, radiationProfile} from 'margoengine/physics/loads';

const mesh = {
  vertices: [-2,-0.5,-1, 2,-0.5,-1, 2,0.5,-1, -2,0.5,-1, -2,-0.5,1, 2,-0.5,1, 2,0.5,1, -2,0.5,1],
  indices: [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,4,7, 0,7,3, 1,2,6, 1,6,5, 0,1,5, 0,5,4, 3,7,6, 3,6,2],
};
const profile = await radiationProfile(mesh, {mass: 4100, density: 1025, centre: [0, 0, 0]});
const loads = {addedMass: profile.addedMass, addedInertia: profile.addedInertia, radiationResonances: profile.resonances};
console.log(profile.draft.toFixed(2), loads.radiationResonances.length > 0); // 0.50 true
const coupledRadiation = await coupledRadiationProfile(mesh, {mass: 4100, density: 1025, centre: [0, 0, 0],
  panels: {depth: 4, frequencies: [0.25, 0.4, 0.6, 0.8]}});
const coupledLoad = {shape: {mesh}, coupledRadiation};
console.log(coupledLoad.coupledRadiation.infiniteMass.length); // 36
```

Omit `capacity` to use the world's rigid body rows. Unsupported load inputs raise `MargoError` with
code `unsupported` and a repair instruction. [Hydrodynamic input help](https://margoengine.com/errors#hydrodynamic-loads)

The coefficients stand alone:
- `cylinderCoefficients(KC, k/D)`, `steadyDrag`, `wakeAmplification` and `cylinderAddedMass`;
- `morison`, `tangentialDrag`, `sphereDrag`, `sheddingFrequency` and `liftMagnification`;
- `ellipsoidAddedMass`, `ellipsoidAddedInertia`, `ellipsoidAlphas` and `equivalentEllipsoid(mesh)`.
- `reynoldsDrag(Re, k/D)`: a cylinder's steady drag below the drag crisis (White's fit) and DNV's above it; with a Reynolds
  number, `cylinderCoefficients` takes it.

`woodyDebrisImpact({closingSpeed, inverseEffectiveMass})` gives the normal pulse from a log's first
impact on a support. The default wood stiffness is 2.4 MN/m, the support is rigid and restitution is 1.
Use `sampleWoodyDebrisImpact(impact, elapsed)` for load vs time. For a mutually filtered rigid pair, call
`accumulateFilteredWoodyContact` once from a staggered `bodyImpulses` contributor when the pair first crosses.
Supply the candidate's contact point, contact normal and both body rows. The routine uses the rows'
translational and rotational mobility and writes both reactions. Keep that pair filtered for the entire
analytic pulse. Ordinary native contacts can use the pulse as a separate load estimate.

```ts
import {sampleWoodyDebrisImpact, woodyDebrisImpact} from 'margoengine/physics/loads';

const impact = woodyDebrisImpact({closingSpeed: 1.2, inverseEffectiveMass: 1 / 270, structureStiffness: 120e6});
if (impact) {
  const peak = sampleWoodyDebrisImpact(impact, impact.timeToPeak);
  console.log(Math.round(peak.force / 1000)); // 30 kN
}
```

`TautMooringSolver` holds a short, near-neutrally buoyant line between a fairlead and a fixed pile
or moving rigid anchor. Specify the two rigid rows, optional body-local pins, unstretched length and
axial rigidity `EA` in newtons. `lineLoad(index)` reports the average tension and anchor reaction for
the step. Put it in the same-rate staggered group before the rigid solver. For a heavy line with sag
or seabed contact, use `Rod` with `segmentLoads`.

For a compact rigid body or hull in a flood, `FloodBodyDragSolver` returns horizontal form drag to the water
with equal and opposite impulse. Give each rigid row a measured frontal area or three principal areas
and a vertical half-extent. A three-axis profile follows the body's rotation. Set `drag: 0` on its
`LoadSolver` body or `drag: false` on `HullSolver` to apply form drag once. Use the same grid and rate for
water and drag, and run drag before water and rigid. The exchange cells must remain wet throughout the step.
The drag solve includes rigid axis locks by default through the optional `bodyMobility` field. Axis locks and joints
carry external support reactions. Use `new FloodBodyDragSolver('floodBodyDrag', {readMobility: false})` for the previous
checkpoint layout.

```ts
import {Physics} from 'margoengine/physics';
import {bedSurface} from 'margoengine/physics/earth';
import {ShallowWaterSolver} from 'margoengine/physics/hydro';
import {FloodBodyDragSolver, LoadSolver} from 'margoengine/physics/loads';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
using physics = new Physics(null, {fixedTimestep: 1 / 60});
const body = physics.addBody(null, {position: [0, -0.25, 0], enabledTranslations: [true, false, true],
  colliders: {shape: 'box', halfExtents: [0.1, 0.1, 0.15], mass: 6}});
const water = new ShallowWaterSolver();
const drag = new FloodBodyDragSolver();
const bed = bedSurface({columns: 1, rows: 1, width: 2, depth: 2, centre: [0, 0]}, new Float64Array(4).fill(-0.5));
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(water, {bed, depth: 0.5, roughness: 0, velocity: () => [0.5, 0]});
const sea = {elevation: (x: number, z: number) => water.sample(x, z).surface,
  water: {...water.flow, medium: 'water' as const}, density: 1000, cell: [0, 0, 0] as const};
world.add(new LoadSolver(), {sea, bodies: [{row: body.row, shape: {box: [0.1, 0.1, 0.15]}, drag: 0}]});
world.add(drag, {bed, bodies: [{row: body.row, halfHeight: 0.1, area: [0.06, 0.06, 0.04], projection: 'box', dragCoefficient: 0.8}]});
world.couple(['loads', drag.id, 'water', 'rigid'], 'staggered');
world.advance(1);
console.log(body.linearVelocity[0] > 0);
```

Use `ShallowWaterSolver.withFloodLoads({paddle, wading})` when cells can dry or rewet. Pass either
profile list or both. Hydro settles the paddle's frontal drag and the wader's drag and buoyancy
against the finalized wet depth. Register the rigid or legged producers first, then register the
returned water with the same bed, density and rate. Use a staggered group that steps the water
before those recipients. `paddle.readBlade(index)` and `wading.readBody(index)` report the applied
loads. Enable `readLoad` on `LeggedLocomotion` and match its `world.levelOf` when it sets the rate.
The standalone `FloodPaddleSolver` and `FloodWadingSolver` use the pre-transport forcing port for
persistently wet exchange stencils.

To return swimmer drag, opt in to `passiveReaction` on `SwimSolver` and add `SwimDragToWater` with the same
bed and rate as the receiving shallow water. Add `SwimDragToWater.actuators()` to return the tail and fin
impulses from the wake field. Both receivers distribute the signed horizontal N·s packets. Couple the
swimmer first, both receivers next and water last. Give the swimmer that water's flow.

```ts
import {bedSurface} from 'margoengine/physics/earth';
import {ShallowWaterSolver} from 'margoengine/physics/hydro';
import {SwimSolver} from 'margoengine/physics/life';
import {SwimDragToWater} from 'margoengine/physics/loads';
import {PhysicsWorld} from 'margoengine/physics/world';

const world = new PhysicsWorld({rate: {num: 60, den: 1}});
const water = new ShallowWaterSolver();
const swimmer = await SwimSolver.load({passiveReaction: true});
const passive = new SwimDragToWater();
const active = SwimDragToWater.actuators();
const bed = bedSurface({columns: 1, rows: 1, width: 3, depth: 3, centre: [0, 0]}, new Float64Array(4).fill(-1));
world.add(water, {bed, depth: 1, roughness: 0});
world.add(swimmer, {flow: {...water.flow, medium: 'water' as const}, bodies: [{position: [0, -0.5, 0], velocity: [0, 0, 0.4],
  mass: 8, volume: 0.008, length: 0.5, width: 0.12, height: 0.12,
  tail: {amplitude: 0.06, span: 0.15, wavelength: 0.52}, frequency: 1.6}]});
world.add(passive, {bed}).add(active, {bed});
world.couple([swimmer.describe().id, passive.id, active.id, 'water'], 'staggered');
world.advance(2);
console.log(water.sample(0, 0).velocity);
```

```ts
import {bedSurface} from 'margoengine/physics/earth';
import {ShallowWaterSolver} from 'margoengine/physics/hydro';
import {LeggedLocomotion} from 'margoengine/physics/legged';
import {PhysicsWorld} from 'margoengine/physics/world';

const legs = await LeggedLocomotion.load({readLoad: true});
const bed = bedSurface({columns: 2, rows: 2, width: 2, depth: 2, centre: [0, 0]}, new Float64Array(9));
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(legs, {bodies: [{kind: 'biped', mass: 75, position: [0, 1.2, 0]}]});
const rate = world.levelOf('legged-locomotion');
const {water, wading} = await ShallowWaterSolver.withFloodLoads({
  wading: {bed, bodies: [{mass: 75, centreOffset: -0.5, halfHeight: 0.4, area: 0.2, volume: 0.03, dragCoefficient: 1}], rate},
});
world.add(water, {bed, depth: 1, roughness: 0, velocity: () => [1, 0], rate});
world.couple(['water', 'legged-locomotion'], 'staggered');
world.advance(1);
console.log(wading!.readBody(0)[1] > 0);
```

A moving slender structure (a `Rod`'s links, a hose, a mooring line) takes its loads from `segmentLoads(sea, options)`
before each step. It uses the members' physics: DNV's coefficients by roughness and KC, Reynolds drag below the crisis,
Eames's drag along, and the wake oscillator, here driven by the segment's own acceleration so a free cable locks in. It hands
each segment:
- a force and a moment held for the step (buoyancy of the wetted length, the Froude-Krylov force, the added mass's share
  of the water's acceleration, vortex lift across the flow, and the fluctuating drag along it at twice the shedding
  frequency, tied to the lift's wake);
- its added mass;
- its drag as a damping toward the flow, which the structure solves implicitly.

Options:
- `period`: the waves' period for KC (default 8), or `Infinity` for a steady current;
- `roughness`, `drag`, `addedMass`, `flows` and `viscosity`;
- `vortex` (or `false`): `strouhal` (default 0.2); `lift` and `drag`, the wake's lift amplitude across the flow and its
  fluctuating drag amplitude along it at Re 5e4 (defaults 0.56 and 0.53, calibrated on a towed pipe; `drag` 0 for none);
  `reynolds` (default true: both grow with the Reynolds number as a free cylinder's swing does, Govardhan and Williamson's
  fit); `inLineWake` (default `'lift'`: the drag fluctuates with the lift's wake; `'own'`: a wake of its own, Srinil and
  Zanganeh's); `coupling` and `inLineCoupling` (default 12); and `amplify` (default false: Vandiver's growth of the mean drag
  with the swing in place of the growth the drag on the relative flow gives).

Measured against flexible pipes towed and in sheared flow (Fu et al. 2025, `tests/rod-viv.test.js`), a rod with these loads
vibrates in the measured modes, and on the held-out cases it is at least as close as the paper's own CFD across the flow, in
line and on the bow, but for a strongly sheared flow's swing (`docs/known-bugs.md`, KB-PHYS-RODVIVSHEAR1). Step it finely
enough for the vibration: a towed pipe's in-line vibration at 19 Hz needs about 600 steps a second
(`new Physics(null, {fixedTimestep: 1 / 600})`).

`takeState()` and `restoreState()` keep its wake oscillators beside a world snapshot. Any structure can call it:
`loads.apply(segments, {time, dt, gravity}, out)`, each segment `{position, tangent, velocity, angularVelocity, diameter,
length}`.

```ts
import {segmentLoads} from 'margoengine/physics/loads';

const still = {density: 1025, elevation: () => 0, water: {medium: 'water' as const, cell: [0, 0, 0] as const,
  sample: (x: number, y: number, z: number, t: number, out = {velocity: [0, 0, 0] as [number, number, number], density: 0, temperature: 0}) =>
    Object.assign(out, {velocity: [0.5, 0, 0], density: 1025, temperature: 288})}};
const loads = segmentLoads(still, {period: Infinity});
const out = [{force: [0, 0, 0], moment: [0, 0, 0], drag: {across: 0, along: 0, flow: [0, 0, 0], at: [0, 0, 0]}, addedMass: 0, addedInertia: 0}] as Parameters<typeof loads.apply>[2];
loads.apply([{position: [0, -3, 0], tangent: [0, 1, 0], velocity: [0, 0, 0], angularVelocity: [0, 0, 0], diameter: 0.05, length: 1}],
  {time: 0, dt: 1 / 60, gravity: [0, -9.81, 0]}, out);
console.log(out[0].force[1] > 0, out[0].drag.across > 0); // true true: it floats a little and the current drags it
```

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

// A heeled crate settles upright under the hydrostatic moment. Body damping lets the example reach equilibrium quickly.
const still = {
  density: 1025,
  elevation: () => 0,
  pressure: (_x: number, y: number) => 1025 * 9.81 * Math.max(0, -y),
  water: {medium: 'water' as const, cell: [0, 0, 0] as const, sample: (_x: number, _y: number, _z: number, _t: number, out = {velocity: [0, 0, 0] as [number, number, number], density: 1025, temperature: 288}) => out},
};
await Physics.load();
const physics = new Physics(null, {fixedTimestep: 1 / 60});
const halfExtents: [number, number, number] = [1, 0.35, 0.6];
const halfHeel = 0.12;
const crate = physics.addBody(null, {
  position: [0, 0.1, 0], rotation: [Math.sin(halfHeel), 0, 0, Math.cos(halfHeel)],
  linearDamping: 1, angularDamping: 1, colliders: {shape: 'box', halfExtents, mass: 1008},
});
const world = new PhysicsWorld({rate: {num: 60, den: 1}})
  .add(new RigidSolver(), {physics})
  .add(await LoadSolver.load(), {sea: still, bodies: [{
    row: crate.row, shape: {box: halfExtents}, pressureModel: 'surface', addedInertia: 'ellipsoid',
  }]})
  .couple(['loads', 'rigid'], 'staggered');
world.advance(60 * 30);
console.log(Math.abs(crate.position[1]) < 0.35, Math.abs(crate.rotation[0]) < 0.01); // true true
```

#### Reflect a dispersive wake at a straight quay

`QuayWakeBoundary` reflects a `WakeSolver` disturbance at a rigid vertical face parallel to X with water on +Z. Give
it the still-water face in metres. `wakeParams` centres the even Z grid on the wall and mirrors the initial state and
optional callback sources. The wake still advances its finite-depth dispersion. Its paired incident and reflected
potential gradients cancel at the wall. `sampleWall(wake, x)` reads the evolved face height in metres and velocity in
metres per second. The Y velocity gives the direction and speed of the waterline motion.

```ts
import {QuayWakeBoundary} from 'margoengine/physics/loads';
import {WakeSolver} from 'margoengine/physics/sea';
import {PhysicsWorld} from 'margoengine/physics/world';

const wall = new QuayWakeBoundary({wallZ: -10.55});
const wake = new WakeSolver();
const world = new PhysicsWorld({rate: {num: 60, den: 1}}).add(wake, wall.wakeParams({
  cells: [64, 64], cellSize: 0.5, centreX: 90, depth: 9.7, sponge: 6,
  sources: (t) => t < 1 / 60 ? [{x: 90, z: -7, radius: 0.8, pressure: 0, volume: 0.2}] : [],
}));
world.advance(40);
const atWall = wall.sampleWall(wake, 90);
console.log(Math.abs(atWall.velocity[2]) < 1e-12); // true
```

For hull pulses, construct the boundary with `surface: hull.wakeSourceField` and
`submerged: hull.submergedWakeSource`. Pass `boundary.surfaceSource` and `boundary.submergedSource` to `WakeSolver`.
Add the hull first, then `world.add(boundary, undefined)`, then the wake. Couple hull, boundary and wake in that
order in the same cell at the 60 Hz level, followed by rigid if it advances the hull. The two input fields are
optional. Keep active hull sources on the wet side. Submerged fields can supply up to 8,192 input rows.

This models an impermeable face extended to the bed, locally straight over the propagating wavelengths. The −Z
half-grid is the mathematical mirror. Keep it under land when displaying the grid. Finite ends, corners, permeable
faces, breaking and overtopping require their own models. The boundary acts on the wake patch. A separately
supplied offshore sea spectrum still requires its own reflecting conditions.
[Rim et al. (2025), §2](https://doi.org/10.1002/eng2.70041).

#### Measure work from a powered hull's wake

`PrescribedWakeWork` reads the same projected volume source as `WakeSolver`. Its work is the change in
the wave's gravitational energy during the volume kick, including the kick's quadratic term.
Add the volume publisher first, then the meter and receiving wake, in one 60 Hz staggered group.
Pass the same volume fields to the meter and the receiving wake. For simultaneous heave, heel or pitch,
set `surface` to the wake’s surface source and leave that field’s pressure column zero. The meter includes
the cross term between surface and projected depth-band displacements. Additional sources or pressure forces
need their own work measurements. Set `mirrored` to true when all inputs include their straight-quay images
and the boundary and initial state are symmetric.

```ts
import {boxGeometry} from 'margoengine/geometry';
import {Physics} from 'margoengine/physics';
import {PrescribedWakeWork} from 'margoengine/physics/loads';
import {SpectralSea, WakeSolver} from 'margoengine/physics/sea';
import {HullSolver} from 'margoengine/physics/seakeeping';
import {PhysicsWorld, RigidSolver, worldMemory} from 'margoengine/physics/world';
await Physics.load();
const density = 1024, depth = 3;
const world = new PhysicsWorld({memory: worldMemory(false)});
using physics = new Physics(null, {arena: world.arena, fixedTimestep: 1 / 60});
const body = physics.addBody(null, {
  position: [-2, 0, 0], linearVelocity: [1.25, 0, 0], enabledTranslations: [true, false, false],
  enabledRotations: [false, false, false], colliders: {shape: 'box', halfExtents: [1, 0.5, 0.5], mass: 1024},
});
const geometry = boxGeometry(2, 1, 1);
const sea = new SpectralSea({waves: {
  frequencies: Float64Array.of(0.5), directions: Float64Array.of(0), energy: Float64Array.of(0), depth, density,
}});
const hull = new HullSolver('hull', {minimumRadius: 0.35, submergedAdvance: [0, 0.25, 0.5]});
const source = hull.submergedWakeSource!;
const meter = new PrescribedWakeWork({source, grid: {cells: [48, 32], cellSize: 0.25, centre: [0, 0], depth, density}});
const wake = new WakeSolver('wake', undefined, source);
world.add(new RigidSolver(), {physics}).add(hull, {
  hulls: [{row: body.row, mesh: {vertices: geometry.positions, indices: geometry.indices}}], sea,
  drag: false, radiation: false, addedMass: false, greenWater: false,
}).add(meter, undefined).add(wake, meter.wakeParams({sponge: 0}))
  .couple(['hull', 'prescribedWakeWork', 'wake', 'rigid'], 'staggered');
world.advance(18);
console.log(meter.work().total > 0); // true
```

#### Bake a reference waterplane

`bakeWakeWaterplane(mesh, waterline, {maxPanelSize, maxRows})` cuts the closed indexed mesh at the
reference waterline in hull coordinates. It returns `[x, z, area]` triples for the wet area. The
positive quadrature weights integrate area and both first moments exactly. For heave, roll and pitch,
multiply each area by the negative vertical velocity of its transformed point and by the time step
to obtain its signed displaced volume. `maxPanelSize` bounds the panel's horizontal spans in metres.
The optional `maxRows` checks the node count before allocation. The receiver's projection radius is a
separate choice. [NIST Digital Library of Mathematical Functions §3.5(v)](https://dlmf.nist.gov/3.5.v)

Give the hull `wakeWaterplane: {plane, radius}` and initialize its `HullSolver` with the wake option.
Bake at its equilibrium draft using its reference mass and density. The solver copies the nodes into
its fixed wake configuration and publishes the posed heave, roll and pitch flux. Either advancing
mode can still publish its own rows. Choose `radius` for the receiver's grid. For the regular
`WakeSolver`, allow at least one cell's radius so the cosine patch has support at every subcell
position. `FiniteQuayWake` handles subcell deposition with its wet-cell projection.

This is a linearized source at the equilibrium waterplane. The node positions follow rigid motion
and the weights stay fixed. The body can use live pressure integration on its wetted hull. Large
heel, appreciable immersion changes and flooding change the cross-section itself and require a
live source integration or a new settled reference. For example, a constant-width box whose side
walls still enclose the surface at 30 degrees has a live cross-section 15.5% larger than its upright
reference due to the secant of the heel angle.

```ts
import {boxGeometry} from '@margoengine/geometry';
import {bakeWakeWaterplane} from '@margoengine/physics/seakeeping';

const box = boxGeometry(4, 2, 2);
const plane = bakeWakeWaterplane({vertices: box.positions, indices: box.indices}, 0, {
  maxPanelSize: 0.5, maxRows: 512,
});
let area = 0;
for (let i = 2; i < plane.nodes.length; i += 3) area += plane.nodes[i]!;
console.log(Math.abs(area - 8) < 1e-12); // true
```

#### Exchange energy with a free-surging hull

`SurgeWakeCoupling` exchanges signed volume and a reciprocal longitudinal impulse with the finite-depth wake.
Use a dynamic rigid body at its fixed reference draft, with local X parallel to the unlocked world X or Z guide.
Keep the other five axes locked. Add the hull with its ambient-only sea and the exchange with its projected
source. Give the receiving wake the exchange's matching grid from `wakeParams`. Pass no surface-source port.

```ts
import {Physics} from 'margoengine/physics';
import {SurgeWakeCoupling} from 'margoengine/physics/loads';
import {WakeSolver} from 'margoengine/physics/sea';
import {HullSolver} from 'margoengine/physics/seakeeping';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
const world = new PhysicsWorld({rate: {num: 60, den: 1}});
const physics = new Physics(null, {arena: world.arena, fixedTimestep: 1 / 60});
const mesh = {
  vertices: [-1,-0.5,-0.5, 1,-0.5,-0.5, 1,0.5,-0.5, -1,0.5,-0.5,
    -1,-0.5,0.5, 1,-0.5,0.5, 1,0.5,0.5, -1,0.5,0.5],
  indices: [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4,
    3,7,6, 3,6,2, 0,4,7, 0,7,3, 1,2,6, 1,6,5],
};
const body = physics.addBody(null, {linearVelocity: [1.25, 0, 0], enabledTranslations: [true, false, false],
  enabledRotations: [false, false, false], colliders: {shape: 'box', halfExtents: [1, 0.5, 0.5], mass: 1025}});
const hull = new HullSolver();
const surge = new SurgeWakeCoupling({
  row: body.row, mesh, waterline: 0, depths: [0, 0.25, 0.5], depth: 3, cells: [40, 32], cellSize: 0.4,
});
const wake = new WakeSolver('wake', undefined, surge.submergedSource);
world.add(new RigidSolver(), {physics}).add(hull, {
  hulls: [{row: body.row, mesh}], sea: {density: 1025, elevation: () => 0},
  drag: false, radiation: false, addedMass: false, rollDamping: false, diffraction: false, drift: false,
  greenWater: false, slamming: false,
}).add(surge, undefined).add(wake, surge.wakeParams())
  .couple(['hull', 'surgeWake', 'wake', 'rigid'], 'staggered');
world.advance(60);
console.log(body.linearVelocity[0] < 1.25); // true
```

The depth-band projection defines the change in wake elevation for each metre of surge over a step. The energy
of that change sets the opposite impulse from the same midpoint displacement. This also lets a pre-existing
wave accelerate the hull from rest. Use calm ambient water and keep the source footprint inside the periodic grid.
This closed-energy tier covers a single free surge degree of freedom. Prescribed motion, heave and roll, guides
with contact friction, independent longitudinal forces and other sources need a separate work account. For display,
add the wake to the visible sea. Use the ambient sea for hull pressure to avoid applying the wake twice.
[Tuck, Scullen and Lazauskas (2000), Eq. 4](https://www.scullen.com.au/DSc/Publications/tuck_scullen_lazauskas_00e.pdf),
[Dyachenko and Zakharov (2012)](https://zakharov75.itp.ac.ru/static/local/zve75/zakharov/2012/2012-03-1-s2.0-S0997754611000811-main.pdf).

#### Exchange wave work with a hull that heaves and heels

`FreeHullWakeCoupling` pairs the same advancing source with the live convex waterplane. Its other three
source columns are heave, roll and pitch about the rigid centre of mass. Connect both ports to one periodic or finite wake.
Allow all three native rotations and leave gyroscopic forces enabled so anisotropic rotation retains its
physical kinetic energy. The wave contributes no yaw torque. Lock the unused horizontal translation.

```ts
import {Physics} from 'margoengine/physics';
import {FiniteQuayWake, FreeHullWakeCoupling} from 'margoengine/physics/loads';
import {HullSolver} from 'margoengine/physics/seakeeping';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
const world = new PhysicsWorld({rate: {num: 60, den: 1}});
using physics = new Physics(null, {arena: world.arena, fixedTimestep: 1 / 60, substeps: 1});
const mesh = {
  vertices: [-1,-0.5,-0.5, 1,-0.5,-0.5, 1,0.5,-0.5, -1,0.5,-0.5,
    -1,-0.5,0.5, 1,-0.5,0.5, 1,0.5,0.5, -1,0.5,0.5],
  indices: [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4,
    3,7,6, 3,6,2, 0,4,7, 0,7,3, 1,2,6, 1,6,5],
};
const body = physics.addBody(null, {linearVelocity: [1.25, -0.02, 0], angularVelocity: [0.02, 0, -0.03],
  enabledTranslations: [true, true, false], colliders: {shape: 'box', halfExtents: [1, 0.5, 0.5], mass: 1025}});
const cells = [37, 19] as const;
const cellSize = 0.25, depth = 3;
const openZ = new Float64Array(4 * cells[0] * cells[1]).fill(1);
for (let x = 9; x < 27; x++) openZ[x + 6 * cells[0]] = 0;
const exchange = new FreeHullWakeCoupling({
  body, mesh, waterline: 0, depths: [0, 0.25, 0.5], depth, cells, cellSize,
  finiteReceiver: () => wake,
});
const wake = new FiniteQuayWake('wake', {
  surface: exchange.surfaceSource, submerged: exchange.submergedSource,
});
world.add(new RigidSolver(), {physics}).add(new HullSolver(), {
  hulls: [{row: body.row, mesh}], sea: {density: 1025, elevation: () => 0},
  addedMass: false, radiation: false, drag: false, rollDamping: false, diffraction: false,
  drift: false, greenWater: false, slamming: false,
}).add(wake, {
  cells, cellSize, origin: [-cells[0] * cellSize / 2, -cells[1] * cellSize / 2],
  depths: [0, 0.2, 0.5, 1.2, depth], openZ, sponge: {cells: 3, rate: 2},
}).add(exchange, undefined)
  .couple(['hull', 'freeHullWake', 'wake', 'rigid'], 'staggered');
world.advance(30);
console.log(wake.heights().some((height) => Math.abs(height) > 1e-6)); // true
```

Use ambient-only hull pressure, one rigid substep at 60 Hz, zero damping, no speed caps and no contact or
prescribed motion in this work test. Add the finite wake before the coupling. With a periodic wake, omit
`finiteReceiver`, add the coupling before `WakeSolver` and initialize the wake with `exchange.wakeParams()`.
Both variants give the exchange exclusive use of their source ports. For a finite receiver, the wave work
includes the perimeter sponge's absorbed joules. Surge uses the reference depth bands
and the live heave and angular samples come from the posed hull's waterplane. The exchange applies only while
the hull has a single convex waterplane. It approximates the swept geometry over each step around the reference
draft and omits a yaw source. The wave exchange uses transpose work pairing as in [Peskin (2002), §5](https://math.nyu.edu/~peskin/papers/acta_numerica.pdf).

#### Exchange longitudinal work through a finite quay wake

Use the same guided body and ambient-only hull from the free-surge example. Set
`finiteReceiver: () => wake` on `SurgeWakeCoupling`, where `wake` is a `FiniteQuayWake` created with
`{ submerged: surge.submergedSource }`. Add the finite wake before the surge coupling so they can check the
shared field, grid, bed depth, density and world. In the staggered coupling run `hull`, `surgeWake`, `wake`
and `rigid` in that order. Configure the receiver directly with its origin, layer depths and fixed open faces.
The receiver must have the guided surge as its only source. Use `wake.work().absorbedJoules` to include
perimeter losses when checking rigid and wave energy.

```ts
import {Physics} from 'margoengine/physics';
import {FiniteQuayWake, SurgeWakeCoupling} from 'margoengine/physics/loads';
import {HullSolver} from 'margoengine/physics/seakeeping';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
const world = new PhysicsWorld({rate: {num: 60, den: 1}});
using physics = new Physics(null, {arena: world.arena, fixedTimestep: 1 / 60});
const mesh = {
  vertices: [-1,-0.5,-0.5, 1,-0.5,-0.5, 1,0.5,-0.5, -1,0.5,-0.5,
    -1,-0.5,0.5, 1,-0.5,0.5, 1,0.5,0.5, -1,0.5,0.5],
  indices: [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4,
    3,7,6, 3,6,2, 0,4,7, 0,7,3, 1,2,6, 1,6,5],
};
const body = physics.addBody(null, {linearVelocity: [1.25, 0, 0], enabledTranslations: [true, false, false],
  enabledRotations: [false, false, false], colliders: {shape: 'box', halfExtents: [1, 0.5, 0.5], mass: 1025}});
const hull = new HullSolver();
const cells = [37, 19] as const;
const cellSize = 0.25;
const hullDepth = 1.5;
const plane = cells[0] * cells[1];
const openX = new Float64Array(4 * plane).fill(1);
for (let z = 1; z < 6; z++) openX[28 + z * cells[0]] = 0;
const surge = new SurgeWakeCoupling({
  row: body.row, mesh, waterline: 0, depths: [0, 0.25, 0.5], depth: hullDepth, cells, cellSize,
  finiteReceiver: () => wake,
});
const wake = new FiniteQuayWake('wake', {submerged: surge.submergedSource});
world.add(new RigidSolver(), {physics}).add(hull, {
  hulls: [{row: body.row, mesh}], sea: {density: 1025, elevation: () => 0},
  drag: false, radiation: false, addedMass: false, rollDamping: false, diffraction: false, drift: false,
  greenWater: false, slamming: false,
}).add(wake, {
  cells, cellSize, origin: [-cells[0] * cellSize / 2, -cells[1] * cellSize / 2],
  depths: [0, 0.2, 0.5, 0.9, hullDepth], openX, sponge: {cells: 3, rate: 2},
}).add(surge, undefined)
  .couple(['hull', 'surgeWake', 'wake', 'rigid'], 'staggered');
world.advance(48);
console.log(body.linearVelocity[0] < 1.25, wake.work().joules > 0); // true true
```

#### Propagate a wake around a finite quay

`FiniteQuayWake` uses a layered water volume with fixed solids. Each horizontal face can be partly or fully
open. Close the faces alongside a quay, leave the ends open, and use open layers below a suspended apron.
Arrays are ordered by X, then Z, then depth. In a staggered group add a `HullSolver` before the finite wake
and give the receiver its `wakeSourceField` and `submergedWakeSource` as `surface` and `submerged`. Leave
the periodic wake out of this connection. The receiver publishes height and provides wet-side surface and
depth-velocity queries from its accepted potential. `work()` reports source work, displaced volume and
any energy or signed volume taken by the optional perimeter sponge.

When at least half the volume grid is solid, the fine-grid solve visits wet cells in their usual
rectangular order using a list of indices. The list takes four bytes per wet cell. Source ports, bulk
potential and snapshots keep their rectangular layouts. This follows the sparse-row traversal principle
in [Yousef Saad, *Iterative Methods for Sparse Linear Systems*, 2nd ed. (2003)](https://doi.org/10.1137/1.9780898718003).

The coarse hierarchy reuses its temporary cell labels and writes Galerkin faces into bounded typed-array
pages in face order. The aperture and all protected faces retain their conductances. This follows the
Galerkin aggregation of [Vaněk, Mandel and Brezina (1996)](https://doi.org/10.1007/BF02238511) and the
sparse edge storage described by [Bell and Garland (2008)](https://mgarland.org/files/papers/nvr-2008-004.pdf).

On eighth-order grids with at least 32,768 volume cells, the potential solve adds the damped column
correction to the Galerkin correction. This saves two fine-grid matrix products per iteration and
one f64 scratch word per volume cell. The acceptance check uses the fine-grid residual.
[Bramble, Pasciak and Xu, *Parallel multilevel preconditioners* (1990)](https://doi.org/10.1090/S0025-5718-1990-1023042-6)

Set `pressureAtDepth: true` and pass `wake.seaSurface()` to the hull for time-centred Bernoulli pressure
and depth velocities from the same potential. Give the finite wake its initial state before advancing the
coupled world. The ordinary hull return uses triangle pressure integration. The wave work ledger tracks
the applied sources and sponge, and the hull's mechanical response has a separate balance.

`temporalOrder` defaults to `2`, one midpoint stage per tick. Set it to `4` for lower time dispersion
using three symmetric midpoint stages with pressure held over the tick. Sources displace water once per
tick and the optional sponge still uses a pair of forward half steps. Fourth order applies to the
conservative wave evolution. Face and layer resolution still control spatial dispersion. The three stages
follow [Haruo Yoshida, *Construction of higher order symplectic integrators* (1990)](https://doi.org/10.1016/0375-9601(90)90092-3).

```ts
import {FiniteQuayWake} from 'margoengine/physics/loads';
import {PhysicsWorld} from 'margoengine/physics/world';

const cells = [16, 8] as const;
const plane = cells[0] * cells[1];
const openX = new Float64Array(2 * plane).fill(1);
for (let z = 2; z < 6; z++) openX[7 + z * cells[0]] = 0;
const wake = new FiniteQuayWake();
const world = new PhysicsWorld({rate: {num: 60, den: 1}});
world.add(wake, {
  cells, cellSize: 0.25, depths: [0, 0.25, 0.8], openX, horizontalOrder: 8, temporalOrder: 4,
  initial: (x, z) => [0.04 * Math.exp(-((x - 1) ** 2 + (z - 1) ** 2) / 0.3), 0],
});
world.advance(120);
console.log(wake.sample(2.25, 1).height, wake.velocityAt(1.875, -0.5, 1));
```

The model is linear, with a conservative pressure and volume work ledger. It resolves waves under a fixed
apron where the geometry and layered grid leave a wet opening. Set `horizontalOrder: 4` or `8`
to reduce the spatial phase error of short waves in open, uniform layers. The default is 2.
All orders follow the same wet faces. The wider stencil reads up to four neighbouring cells on each side.
Use a domain, layer and grid refinement check for wave scattering. See the [finite quay limits](../../docs/limits.md#finite-quay-wake-and-under-apron-flow-sea-12).

#### Send a submerged wake source at its own depth

With a finite receiver, a publisher can report the depth of each signed volume in metres below still
water. Call `finiteQuayPointSource` to describe its port and pass it as `points` on `FiniteQuayWake`.
A radius at or below one cell uses the connected bilinear footprint. Refine the grid to resolve a
narrower source. Supply five f64 values per row in layout 1 in this order: X, Z, projection radius, point depth and signed
volume in cubic metres. Run the publisher before the receiver in the same staggered group. Depth
weights split the source between wet neighbours, using the free surface as the upper neighbour and
the last wet cell at the bed. This input replaces the band source. Surface displacement and applied
pressure can still enter through the independent `surface` field.

```ts
import {finiteQuayPointSource, FiniteQuayWake} from 'margoengine/physics/loads';
import {PhysicsWorld, regionWords, type Region, type Solver, type SolverHost} from 'margoengine/physics/world';

const points = finiteQuayPointSource('demo.pointVolumes');
const wake = new FiniteQuayWake('wake', {points});
let host: SolverHost;
let region: Region;
const source: Solver<undefined> = {
  describe: () => ({ id: 'points', rate: 0, stableRate: () => 0, fields: [{field: points, access: 'write'}] }),
  init(owner) {
    host = owner;
    region = host.allocate('volumes', 5 * 8, 'f64', 1);
  },
  step({tick}) {
    const row = regionWords(host.memory, region) as Float64Array;
    row.set([0.875, 0.875, 0.10, 0.31, tick === 0 ? 0.002 : 0]);
  },
  exportPorts(tick) { return [{field: points.name, region, tick, cell: host.cell}]; },
  importPorts() {},
  stateRegions: () => [region],
  extraState: () => [],
};
const world = new PhysicsWorld({rate: {num: 60, den: 1}});
world.add(source, undefined).add(wake, {
  cells: [16, 8], cellSize: 0.25, depths: [0, 0.2, 0.45, 1.2],
}).couple(['points', 'wake'], 'staggered');
world.advance(4);
console.log(wake.work().displacedVolume); // about 0.002 m³
```

#### Bake a point-depth advancing hull

A hull can publish these points from its indexed geometry. Use `bakeWakeAdvancePoints` at the hull's
equilibrium waterline with positive receiver-independent `panelSizes` for each of its chosen depth
intervals. The closed outward-wound mesh supplies the signed longitudinal area of its wet panels.
Within each bin, centroids for positive and negative areas retain the net signed volume and its
three first moments. `maxRows` is an optional bake budget. [Tuck, Scullen and Lazauskas (2000), Eq. 4](https://www.scullen.com.au/DSc/Publications/tuck_scullen_lazauskas_00e.pdf)

Give the hull `wakeAdvancePoints: {geometry, radius}`. Pass the same descriptor to the hull
solver as `pointAdvance` and to the finite receiver as `points`. Select one advancing source
mode. The surface-motion field can still carry independent heave, roll and pitch. The projection
radius controls deposition on the receiving grid. The bake controls geometry resolution.
This is a linearized reference hull source. Point depths follow the equilibrium plane and the
source's XZ positions follow the posed reference plane. Large immersion changes, large angles
and changing wetted geometry require a live panel integration or a new settled reference.

```ts
import {boxGeometry} from 'margoengine/geometry';
import {Physics} from 'margoengine/physics';
import {finiteQuayPointSource, FiniteQuayWake} from 'margoengine/physics/loads';
import {bakeWakeAdvancePoints, HullSolver} from 'margoengine/physics/seakeeping';
import {PhysicsWorld, RigidSolver} from 'margoengine/physics/world';

await Physics.load();
const density = 1024;
const world = new PhysicsWorld({rate: {num: 60, den: 1}});
using physics = new Physics(null, {arena: world.arena, fixedTimestep: 1 / 60, substeps: 1});
const body = physics.addBody(null, {
  linearVelocity: [1, 0, 0], colliders: {shape: 'box', halfExtents: [2, 1, 1], mass: 8 * density},
});
const box = boxGeometry(4, 2, 2);
const mesh = {vertices: box.positions, indices: box.indices};
const geometry = bakeWakeAdvancePoints(mesh, 0, {depths: [0, 0.25, 0.5, 1], panelSizes: [0.25, 0.25, 0.5]});
const points = finiteQuayPointSource('ship.advancingPoints');
const hull = new HullSolver('hull', {pointAdvance: points});
const wake = new FiniteQuayWake('wake', {surface: hull.wakeSourceField, points});
world.add(new RigidSolver(), {physics}).add(hull, {
  hulls: [{row: body.row, mesh, wakeAdvancePoints: {geometry, radius: 0.25}}],
  sea: {density, elevation: () => 0},
  addedMass: false, radiation: false, rollDamping: false, drag: false, greenWater: false, slamming: false,
}).add(wake, {
  cells: [40, 24], cellSize: 0.25, origin: [-5, -3], depths: [0, 0.125, 0.25, 0.5, 1, 2], density,
}).couple(['hull', 'wake', 'rigid'], 'staggered');
world.advance(1);
console.log(wake.energy() > 0); // true
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
- `NonlinearSea.load(options, {threads, signal})` lazily loads the native pair evaluator. It returns the same second-order elevation and normals. The caller participates with one by default, with two or four participants available in Node or an isolated browser worker. Use `using` to release helpers. `readNativeWork()` reports pairs and SIMD work from the last successful query.

Supply an aligned water current with finite velocity and positive kelvin. Dry depths, malformed spectra and invalid current samples throw with a code and a fix. A rejected query leaves its caller-supplied sample intact.

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

// Opt into the same pair evaluation in native Wasm.
using native = await NonlinearSea.load({spectrum, rogues: sea.rogues});
console.log(native.elevation(0, 0, 600) === sea.elevation(0, 0, 600)); // true
console.log(native.readNativeWork()?.pairs); // 12,880 for 160 components

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

The default epoch is J2000, with TT and TDB seconds zero and UT1 seconds −63.86. To set another epoch, give `epoch.ttSeconds` and `epoch.ut1Seconds` as seconds from JD 2451545.0 on their respective timescales. Supply `epoch.tdbSeconds` when known. It defaults to TT. `timeScale` defaults to one astronomical second per world second. Zero freezes the sky and negative values run it backwards. A scale above 0 is declared to the world, so a solver reading the sky's insolation or tide must run at the same (a surge's water does); a frozen or reversed sky counts as the world's time. Optional `orientation` supplies IERS celestial pole and locator, polar motion and TIO locator for the run. Defaults use IAU 2006 precession, four nutation terms and zero polar motion.

For high-precision or historical work, pass `ephemeris: new SpkEphemeris(bytes)` with a complete JPL planetary/lunar SPK kernel such as DE440s. The input can be an `ArrayBuffer` or `Uint8Array`. The reader copies the bytes and supports IEEE little- and big-endian J2000 type 2 and type 3 data. The default analytic mode uses JPL's fitted 1800–2050 orbit elements and the Meeus lunar series. SPK solar and lunar directions include light time and geocentric stellar aberration. Insolation is a geometric direct-beam estimate above the horizon. Clouds, atmospheric extinction and ocean response are supplied by their own solvers.

Use `CelestialSolver.load({ threads: 1 })` to run the eight Standish orbit rows with optional Rust/Wasm SIMD. It defaults to one native participant. Choose two or four for shared world memory in Node or an isolated browser worker. The synchronous constructor retains the JavaScript evaluation, and a supplied SPK uses its own reader. `readNativeWork()` reports the planet rows, SIMD pairs and Kepler iterations from the latest accepted analytic epoch. Stop advancing the world before disposing the solver. Load accepts an optional `AbortSignal`.

Both publications carry the solver's signed world cell and six f64 values in the memory named by the port. The values are Earth-fixed astronomical vectors. Sample them at an absolute WGS 84 site or Earth-fixed point in metres across world-origin shifts. An unsupported epoch or malformed request raises a coded error with the remedy at [celestial errors](https://margoengine.com/errors#celestial).

`trackSolarRow` takes an east–north–up direction and returns the requested rotation, physical angle and adjacent-row shading. It defaults to a north–south horizontal axis, zero cross slope and calibration offset, a width-to-spacing ratio of 0.4, ±90° travel, backtracking enabled and a horizontal night-stow angle. To stow in wind, pass `windSpeed` (default zero) and `stowAt`, both in m/s. See `TrackerOptions` for axis, cross-slope, travel and calibration options.

```ts
import {CelestialSolver, trackSolarRow} from '@margoengine/physics/celestial';
import {PhysicsWorld} from '@margoengine/physics/world';

using celestial = await CelestialSolver.load();
const world = new PhysicsWorld({rate: {num: 24, den: 1}}).add(celestial, {});
world.advance(24);

const sun = celestial.insolation({latitude: 0, longitude: 0});
const tide = celestial.tide([6378137, 0, 0]);
const row = trackSolarRow(sun.direction, {groundCoverageRatio: 0.5, stowAt: 15, windSpeed: 8});
console.log(sun.horizontal > 0, Number.isFinite(tide.potential), row.mode); // true true track
```

### Ice thermodynamics

`IceSolver` advances lake, river and sea ice, frost and dripping icicles at 60 Hz on a `PhysicsWorld`. Pass one
site per column, frost patch or icicle. `sample(index)` returns thickness (or icicle radius), icicle length,
liquid drainage and steam in kg/s, and externally absorbed heat in watts.

```ts
import { IceSolver } from '@margoengine/physics/ice';
import { PhysicsWorld } from '@margoengine/physics/world';

using ice = await IceSolver.load({ threads: 1 });
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
Below freezing, `temperature` sets the outer cold boundary for conduction through ice and the prescribed
snow resistance. Above freezing it supplies the warm-side temperature next to the melting surface.
Set `surfaceHeatTransfer` in W/(m² K) to describe that boundary. It defaults to 10. Surface thaw consumes
that heat directly at the freezing point, independently of how thick the remaining ice is.
Frost starts at zero thickness with density 100 kg/m³, ambient vapour pressure 400 Pa, air temperature 273.15 K,
mass transfer coefficient 0.002 m/s and thaw heat transfer coefficient 10 W/(m² K). Icicles have an initial
attachment radius of 0.005 m, zero length, water supply 0.00001 kg/s, and separate side and tip heat transfer
coefficients of 10 W/(m² K). `area` is the footprint that absorbs external heat, default 1 m² for sheets and
frost or π times the squared attachment radius for an icicle. Each default can be overridden per site.

`new IceSolver()` remains synchronous. `IceSolver.load()` selects the optional native fusion, sensible
heating and vaporization work with one participant by default. Choose two or four with shared world
memory in Node or a cross-origin-isolated browser worker. `readNativeWork()` returns the latest
accepted site counts. Dispose the solver when stopping its world.

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

using acoustics = await UnderwaterAcousticsSolver.load();
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
The solver preserves precise reflection counts in uniform columns with many repeats. If the count or beam
state exceeds float64 range, it reports a coded error and retains the previous accepted state.
For another solver, read the layout-1 f64 ports below. The source ID prefixes each suffix.

| Descriptor property | Suffix | Words per ray |
| --- | --- | --- |
| `pathField` | `.path` | Range, depth, total path length and beam width in metres |
| `signalField` | `.signal` | Real and imaginary on-axis pressure in Pa |
| `delayField` | `.delay` | Travel time in seconds |

The example loads the optional native tracer. Use `new UnderwaterAcousticsSolver()` for the synchronous
TypeScript path. Both use the same world fields and snapshot
layout. `load({ id, threads, signal })` accepts the same ID as the constructor, a native thread count
(the default is one), and an optional abort signal. Two or more threads use `worldMemory(true)` from
the physics world entry. Run a threaded browser world in a Worker on a cross-origin-isolated page.
After removing a loaded solver from the world, call `acoustics[Symbol.dispose]()` to close its workers.
`acoustics.workCounts()` reports rays, executed drifts and real boundary crossings for the last
successful tick, including each worker's share. A folded uniform ray counts once for drift and as
many times as it reached a boundary.

The fixed-camera Margo cutaway draws the accepted rays and signed beam-axis pressure. Run
`npm run test:gpu:underwater-surface -w @margoengine/physics` from the repository. Set
`MARGO_KEEP_UNDERWATER_FRAMES=1` to keep the reviewed frames under
`packages/physics/test-results/underwater-waveguide/`.

### Orbital mechanics (`margoengine/physics/orbit`)

`OrbitSolver` integrates interacting gravitational bodies and massless tracers on the 60 Hz physics clock.
The optional SIMD kernel implements reversible fourth-order Yoshida stepping in vacuum, with a Verlet option.

```ts
import { OrbitSolver, keplerState } from 'margoengine/physics/orbit';
import { PhysicsWorld } from 'margoengine/physics/world';

using orbit = await OrbitSolver.load();
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
All three ports use layout 1 and the solver ID as the prefix (default `orbit`). Import `worldMemory` from
the physics world entry and use `worldMemory(true)` with `OrbitSolver.load({ threads: 4 })` to partition
the native gravity sweep. The default is one thread. Browser worlds with multiple threads run inside
a Worker on a cross-origin-isolated page. The optional `signal` can cancel the load. Dispose the
solver after removing it from the world to close the workers. `orbit.workCounts()` reports each
partition's actual pair geometry calculations and source contributions from the last accepted tick.
Registry cells shift without changing the local inertial coordinates.

`keplerState` samples a bound ellipse and keeps the small periapsis displacement and speed stable
near eccentricity one. `keplerDiskSample` integrates a tracer's phase with prescribed radial drift.
A viewer can set `hole.diskTime = orbit.elapsedSeconds` to replay a disk on the simulation's clock.
Run `npm run test:gpu:orbit-surface -w @margoengine/physics` for the fixed-camera live three-body
plate, driven by the accepted registry positions.

## Limits

- Scale from a parent that shears a part is not represented: a body has a position and a rotation. Mesh scale is read once when a geometry-derived collider is built.
- Debug drawing is a line buffer from `debugRender()` for `@margoengine/lines`, not a renderer.
- Built in optional entries: soft bodies, ropes, cloth, finite-element volumes, tearing and deformable colliders (`@margoengine/physics/soft`); multibody joints, PID controllers and snapshots are built in the root entry (see [docs/rapier-parity.md](../../docs/rapier-parity.md) and [docs/physics-collision-parity.md](../../docs/physics-collision-parity.md)).
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
It supports plain and shared world memory. The browser loads the shared build when the page can use shared memory.
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

Set `threads` to 1, 2 or 4 in `HeatConduction.load()` for explicit grids. The default is one native participant.
Choose two or four for a shared world in Node or an isolated browser worker and dispose the heat solver when
its world is finished. `heat.readNativeWork()` reports decoded and stencil cells, including SIMD pair counts,
from the most recent accepted explicit step. Implicit integration uses one participant.

The temperature, enthalpy, and liquid-fraction fields are f64 grids in that same order.
A coupled solver can add J per tick per cell into `heat.enthalpyField`. Sources and readers must use
the same grid and signed origin cell. Borrowed inputs are read from their owning memory. A rejected step retains
the accepted thermal fields. The world snapshots geometry, material coefficients, and state.
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
The displacement, stress and reaction ports share the heat grid's signed origin. A rejected input or equilibrium
solve preserves the last accepted mechanical results.


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
using swim = await SwimSolver.load();
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
console.log(fish.position, fish.orientation, tail.position, fish.finDisplacement, swim.workCounts());
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
(defaults to the greater of the explicit open-loop frequency and the fast envelope for body length).
The envelope follows Sánchez-Rodríguez, Raufaste and Argentina (2023), equation 4 and Figure 1. Its
fitted constants are 22 Hz, a crossover length of 0.4 m and curvature 4. Short swimmers can use higher
frequencies and long swimmers have lower ceilings. Supply an authored `maximumFrequency` to choose
another limit. `responseSeconds` defaults to 1 s. `burstSeconds` and `coastSeconds` select a
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

`swim.cell` identifies the origin of sampled positions and wake ports. The solver can use
`SwimSolver.load({ threads: 4 })` with shared world memory. The caller and three helpers integrate
independent body rows and publish only after every native candidate passes. For a browser, run a shared
world in an isolated Worker. One partition is the default. `workCounts()` reports the native bodies,
paired SIMD axis updates and passive reaction rows in the last accepted tick. Dispose the solver when finished.

## Falling light bodies

Use `@margoengine/physics/falling` for rigid paper, dry leaves, ash flakes, plate-like snow and feathers,
autorotating seeds, and round grains. Each body advances at the same world time, with adaptive dyadic Runge–Kutta
substeps inside each tick. Densities and velocities are in SI units.

```js
import { FallingSolver } from '@margoengine/physics/falling';
import { PhysicsWorld } from '@margoengine/physics/world';

using falling = await FallingSolver.load();
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
`FallingSolver.load({ id, rate, signal, threads })` loads Wasm on demand. Rate 2 (240 Hz) and one participant are the defaults. Set `threads` to 2 or 4 in Node or an isolated browser worker with shared world memory. Each worker owns contiguous body rows. The solver joins the rows before running contacts in body order. `readNativeWork()` reports body rows, RK4 evaluations and SIMD state pairs for the last accepted step. Dispose the solver to release its worker pool.
`falling.poseField` publishes layout-1 f64 rows in input order, in the solver's origin cell.
Each row holds position xyz, quaternion xyzw, linear velocity xyz and angular velocity xyz.
`falling.pose(index)` copies a row. `writeSpheres` writes the positions, radii and velocities of rounded
bodies to a supplied f32 draw buffer in their original order. Set the draw offset to the solver's cell in
the renderer's coordinate system. The solver refuses an unrepresentable draw row before replacing any caller
data. Air and boundary callbacks are read-only. A failed sample, collision or numeric step preserves the
previous accepted poses and native work receipt.

## Pedestrian contact and crowd motion

Use `PedestrianCrowd` for walkers that push, yield, and queue around doorways. It advances bodies
on the PhysicsWorld clock with physical contact forces and a separate response to predicted encounters.
A person can turn their elliptical torso through a narrow aperture. The solver reads a NavMesh route and
height surface, so walkable grades and the positions used to animate feet stay in the same coordinate system.

```ts
import { PedestrianCrowd } from '@margoengine/physics/pedestrians';
import { PhysicsWorld } from '@margoengine/physics/world';

using crowd = await PedestrianCrowd.load();
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

`PedestrianCrowd.load({ id, level, threads, signal, readIntent, readForces, fields })` loads SIMD Wasm on
demand. Defaults are id `pedestrians`, preferred level 0 and both input ports disabled. When enabled,
write `PEDESTRIAN_INTENT_FIELD` with [vx, vz] and `PEDESTRIAN_FORCE_FIELD` with [fx, fz], one
f64 row per walker. Readers can use `PEDESTRIAN_KINEMATICS_FIELD` for motion and accumulated
stride distance, and `PEDESTRIAN_CONTACT_FIELD` for [fx, fz, normalLoad, density,
anticipatoryFx, anticipatoryFz]. All four use `PEDESTRIAN_LAYOUT`. Use different `fields` names for
multiple groups within one world. Input rows are aligned in the memory named by the port. Publications
use the solver's signed cell, including after an origin shift. An invalid ground height or control
leaves the accepted pose, contacts and route cursor intact. Update targets between steps.

The default is one native participant. Use two or four with shared world memory in Node or an
isolated browser worker. They split independent drive and wall-integration rows. Walker-to-walker
impulses retain canonical order. `readNativeWork()` gives accepted row, wall and SIMD counts.
Stop advancing the world before disposing the group. [Pedestrian error remedies](https://margoengine.com/errors#pedestrians)

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

Outlets default to closed. An open edge keeps its elevation and exports arriving water and fluvial sediment. Hillslope and thermal exchange stop at this edge. Provide
the same `floor` to the landscape and `bedrock` to TerrainBed if there is a minimum elevation. Optional
`rainField`, `shearField` and `rootCohesionField` accept layout-1 cell or vertex scalars in m/s, Pa and Pa.
Use `SedimentTransport.shearField` or a time-averaged equivalent for hydraulic forcing. `load` also accepts
`id` (default `landscape`) and `signal`. Discharge, gross incision and sediment flux are layout-1 f64 vertex
fields. TerrainBed applies a published change at its next tick, so diagnostics describe the most recent
calculated change one tick before it becomes terrain. Use the bed for the current rendered elevation.

For an animated terrain pass, advance or seek the `evolveRelief` world and draw the accepted
terrain from `snapshotRelief()`. Match the Biomes relief's sampling grid to the rendered terrain.
For an optional shared native step, load with `threads: 4` and use a PhysicsWorld created with
`worldMemory(true)` from `@margoengine/physics/world`. The default is one thread. Run additional
workers in Node or a cross-origin-isolated browser worker. `workCounts()` reports native preparation
and downstream visits for the last successful runtime tick. Remove the solver before disposing it.

A refused landscape tick retains the last accepted sediment ledger and bed contribution.
Keep the predicted elevation within the TerrainBed float32 representation.

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
`water.windStress: false`. Use the same positive `timeScale` as the connected world solver
(default 1). Track speed stays in metres per simulated second. The solver publishes only a finite and
complete trial. Its outputs carry the current signed origin cell.

Use the optional native sampler with `VortexForcing.load({ water: true, threads: 1 })`. One
participant is the default. Two or four need shared world memory and an isolated Worker in browsers.
The ordinary synchronous constructor and custom vortex profiles use the scalar sampler.
`StormVortex.waterProfile()` copies the built-in coefficients. `readNativeWork()` copies native wet-cell,
pressure, wind and SIMD counts after an accepted native step. Dispose when the world stops using native
helpers. The following example couples the native sampler to actual shallow water.

```ts
import { TerrainBed } from '@margoengine/physics/earth';
import { ShallowWaterSolver } from '@margoengine/physics/hydro';
import { StormVortex, VortexForcing } from '@margoengine/physics/vortices';
import { PhysicsWorld } from '@margoengine/physics/world';

const grid = { columns: 4, rows: 4, width: 4000, depth: 4000, centre: [0, 0] } as const;
const bed = new TerrainBed();
const water = new ShallowWaterSolver('coastal-water');
using storm = await VortexForcing.load({ id: 'coastal-storm', water: true });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
world.add(bed, { ...grid, elevations: () => -4 });
world.add(water, { bed: bed.bed, depth: 4 });
world.add(storm, {
  vortex: new StormVortex({ center: [-28000, 0], radius: 30000, pressureDrop: 8500 }),
  water: { width: 4, depth: 4, spacing: [1000, 1000], origin: [-1500, -1500] },
});
world.advance(1);
console.log(storm.weather().pressure, storm.readNativeWork()?.wetCells);
```

## Seismic waves and ground motion

`@margoengine/physics/seismic` solves P and SV waves through a vertical geological section. Supply density
and the two wave speeds per cell or use one material throughout. The top surface is traction-free.
The optional absorbing strip damps the sides and bottom. Grid spacing defaults to 10 m on both axes.
Moment sources take x and depth in metres from the section's top-left corner. The reported vertical
motion is positive up. World tick rate follows the spatial Courant bound.

```ts
import { SeismicGround } from '@margoengine/physics/seismic';
import { PhysicsWorld } from '@margoengine/physics/world';

using ground = await SeismicGround.load({ threads: 1 });
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
console.log(ground.readNativeWork()?.velocityCells);
```

The ground-motion field supplies acceleration for cameras and structural consumers. `SeismicInertialLoad`
maps selected rigid bodies to support columns and adds a mass-scaled base-acceleration load. The optional
single-mode building receiver defaults to a 0.05 damping ratio. Its soil receiver compares peak horizontal
cyclic demand with the supplied resistance. The default boundary attenuation targets an outgoing amplitude
of 0.001 through at most 12 cells, reduced automatically for small grids. Set `absorbingCells: 0` to study
boundary reflections. A `signal` can cancel kernel loading.

One native participant is the default. Choose two or four with shared world memory in Node or a
cross-origin-isolated browser worker. The traction-free surface update stays on the caller. Helpers
finish disjoint velocity rows before any stress row advances. `readNativeWork()` reports accepted
cell and SIMD-pair counts. Dispose the solver when its world stops. Invalid native or site results
preserve the accepted wave section, surface output, building response and work receipt.

## Outdoor sound

`@margoengine/physics/outdoor-sound` gives each source–listener link its travel time and eight octave gains.
Set `air` to a Weather wind field for advection and vertical refraction, and `bed` to a TerrainBed for
diffraction. An explicit `groundY` adds a plane reflection where both legs reach the reflecting point. The reflected pressure defaults to full strength
and `groundReflection: 0` turns it off. With still air, temperature defaults to 293.15 K, pressure to
101,325 Pa, and relative humidity to 0.5. Call `read` after advancing the world. Callbacks for moving links
take world seconds and return metres relative to the solver cell. For a nonstandard world cell size, pass the
same `cellSize` to the solver. The default is 4,096 m per cell.
The spreading reference is 1 m and integration uses 24 intervals per leg by default.

`new OutdoorSound()` uses the scalar integrator. `OutdoorSound.load()` lazily loads the SIMD path and accepts an optional solver `id`,
a cancellation `signal` and `threads` of 1 (default), 2 or 4, including the caller. Multiple participants need Node
or a cross-origin-isolated browser worker. `workCounts()` reports work for the last successful native integration.
Those diagnostic counters update on the next solved tick after restoring a snapshot.

```ts
import { OutdoorSound } from 'margoengine/physics/outdoor-sound';
import { PhysicsWorld } from 'margoengine/physics/world';

const paths = await OutdoorSound.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(paths, {
  links: [{ source: [0, 3, 0], listener: [3000, 3, 0] }],
});
world.advance(1);
console.log(paths.read().delaySeconds.toFixed(2)); // 8.74
paths.dispose();
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
fixed timestep to this rate. Add the rigid and modal solvers in the same signed world cell. Select `both` to include fractures, then map joints in the rigid solver's
`jointBreaks` setup or add a separate fracture producer. Each joint mapping provides its track, released
strain energy in J, effective mass in kg and optional fraction of that joint's energy (default 1).
`modalFractureImpulse` converts those values to an equivalent impulse for a fragment starting at rest.

For multiple independent tracks in a shared world, set `threads` to 2 or 4 when loading the solver in Node
or an isolated browser worker. The default uses one native participant. Use `using` or call
`sound[Symbol.dispose]()` after the world is finished. `sound.readNativeWork()` reports the tracks, PCM
samples, paired modal updates and roughness rotations of the last accepted block for each participant.
A rejected port or native block leaves the prior sound state and retained PCM intact.

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

Without an explicit emissivity setting, the longwave calculation combines the dry atmosphere with the current
liquid-water path. The dry emissivity defaults to 0.15. For a prescribed grey layer, set `emissivity` as before,
or choose `longwave: 'grey'`. To change the dry baseline while retaining liquid-water absorption, choose
`longwave: 'liquid-water-path'` and set `emissivity`. Grey emissivity zero leaves the separate surface fluxes active.

`DrainageFog.load({threads})` takes 1 (the default), 2 or 4 native participants. For 2 or 4, create the world
with `worldMemory(true)` and run from a worker on the web. `workCounts()` reports the last accepted step,
with row and SIMD pair counts for each participant. `using` releases the workers. Use `worldCellSize`
(default 4096 m) to match a different world cell size when reading wind from another signed cell.

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
using snowpack = await Snowpack.load({ threads: 1 });
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

Snowpack loads one native participant by default. Set `threads` to 2 or 4 in Node or an isolated browser worker with a shared-memory world. Surface saltation uses its original order. Workers update independent layers in their own columns. `readNativeWork()` copies the counts from the last accepted physical step. Dispose the solver after the world has finished with it. A rejected input leaves accepted cover and discharge available to readers.

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
Wind locations use the provider's signed cell origin. Set the transport's `cellSize` to the world's value
when it differs from the 4,096 m default. Invalid positions, inputs or native intervals report a coded
error before accepted mass, bed change or diagnostic ports are replaced.

`load({ threads: 2 })` and `load({ threads: 4 })` divide slope, forcing, saltation and diagnostic vertices
with native helpers. The count includes the caller. They require `worldMemory(true)` in Node or a
cross-origin-isolated browser worker. The default of one participant also works with plain memory and in
a browser window. Use one threaded instance per world and call `dispose()` after its final step.
`workCounts()` reports substeps and per-participant work and SIMD pairs from the most recent step this
instance computed, or `undefined` before it computes a step. The work report is independent of snapshots.

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
using aquifer = await GroundwaterSolver.load({ followTerrain: true });
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
and an abort `signal`. Set `threads` to 1 (default), 2 or 4, counting the caller. Multiple participants
need a shared-memory world and an isolated Worker in browsers. Dispose a threaded aquifer when the world stops
using it. `readNativeWork()` reports accepted row and SIMD counts. The linear solve defaults to a relative
residual of `1e-12`.
`secondsPerSecond` defaults to 1. Outlet rates remain per world second when underground time accelerates.
The budgets record storage, recharge, boundary inflow and outflow, spring discharge and seepage in cubic metres.
The four outputs carry the current solver cell. A failed trial leaves accepted columns, budgets and work intact.

### Confined Darcy and Hele-Shaw cells

`solveConfinedFlow` solves steady confined flow on a cell grid: an aquifer slice, a permeameter or a Hele-Shaw cell
(two plates a gap apart, where the gap-averaged flow is a potential flow). Give a transmissivity, the sides held at
a fixed potential and any solid cells; it returns the potential, face flows, stream function and the mean speeds,
and `traceStreamlines` follows dye lines with their travel times.

```ts
import { heleShawTransmissivity, solveConfinedFlow, streamlinePoint, traceStreamlines } from '@margoengine/physics/groundwater';

const columns = 84, rows = 48, cellSize = 0.005;
const active = new Uint8Array(columns * rows);
for (let row = 0; row < rows; row++)
  for (let column = 0; column < columns; column++)
    active[column + row * columns] = Math.hypot((column + 0.5) * cellSize - 0.21, (row + 0.5) * cellSize - 0.12) > 0.04 ? 1 : 0;
const cell = solveConfinedFlow({
  columns, rows, cellSize, active,
  transmissivity: heleShawTransmissivity(0.001, 0.08), // 1 mm gap of glycerol solution, Pa s
  thickness: 0.001,
  sides: { minX: 420, maxX: 0 }, // Pa
});
const [lane] = traceStreamlines(cell, { seeds: [0.3] });
console.log(cell.inflow, cell.maxSpeed, streamlinePoint(lane, lane.duration / 2));
```

The potential is the hydraulic head for an aquifer (transmissivity K b, m²/s) or the pressure for a Hele-Shaw gap
(b³ / 12μ). Transmissivity may vary per cell; faces take the harmonic mean, and a fixed side sits half a cell
from the cell centre. `fixed` holds a potential per cell (NaN for free cells) for wells and inner boundaries, and
`sources` adds inflow per cell. A free cell with no path to a fixed potential is refused with a `MargoError`
`'failed'`. The conjugate-gradient solve stops at a relative residual of `1e-12` (`tolerance`).

## Pipe flow, hydraulic structures and machines

`@margoengine/physics/hydraulics` covers water in pipes, through openings and machines, and in open channels, as
plain deterministic functions: Darcy-Weisbach friction (Colebrook, Haaland or Churchill), pipe runs and siphons,
orifices and basins equalising through a sluice, Venturi meters, steady pipe networks with reservoirs, valves and
pumps, Joukowsky water hammer and a lumped hydraulic ram, the Pelton runner, a hinged bellows, and the hydraulic
jump with critical and normal depth. It loads no Wasm and needs no world.

```ts
import {
  equalize, hydraulicJump, HydraulicRam, orificeConductance, peltonRunner, pipeFlow, siphon, solveNetwork, venturi,
} from '@margoengine/physics/hydraulics';

const tap = pipeFlow({ head: 12, diameter: 0.05, length: 120, roughness: 4.6e-5, minorLoss: 3 });
const arch = siphon({ drop: 0.1, crownRise: 0.18, diameter: 0.013, length: 1.2, minorLoss: 1.65 });
const lock = equalize({ area: 82.8, level: 0.92, otherLevel: 2.72, openingArea: 1.75, dischargeCoefficient: 0.62, time: 60 });
const meter = venturi({ inletDiameter: 0.053, throatDiameter: 0.026, flow: 0.0005 });
const jump = hydraulicJump({ upstreamDepth: 0.028, upstreamSpeed: 3.2, width: 0.28 });
const wheel = peltonRunner({ netHead: 8.6, nozzleDiameter: 0.017, pitchRadius: 0.167, rpm: 360 });
const town = solveNetwork({
  nodes: [{ id: 'dam', kind: 'reservoir', head: 100 }, { id: 'square', elevation: 40, demand: 0.02 }],
  links: [{ id: 'main', from: 'dam', to: 'square', length: 900, diameter: 0.2, roughness: 2.6e-4 }],
});
const ram = new HydraulicRam({
  supplyHead: 1.6, driveLength: 8, driveDiameter: 0.042, driveResistance: 1.14e10, compliance: 7.5e-10,
  waste: { conductance: orificeConductance(4.2e-4, 1), tripFlow: 7.9e-4, closeTime: 0.036, holdTime: 0.09, reopenPressure: 4900, reopenTime: 0.055 },
  checkConductance: 5.05e-6, deliveryConductance: 3.55e-6, vessel: { volume: 0.0023, exponent: 1.24 },
});
const cycle = ram.settle(4, { signal: AbortSignal.timeout(10_000) });
console.log(tap.flow, arch.crownPressure, lock.level, meter.pressureDrop, jump.downstreamDepth, wheel.efficiency,
  town.heads.square, cycle.meanDelivery * 60000);
```

Every function takes SI units and defaults to water at 20 °C (`water(t)` gives density, viscosity, vapour pressure
and bulk modulus from Kell 1975, Kestin et al. 1978 and Buck 1981) and to the engine's 9.81 m/s² gravity; pass
`liquid` and `gravity` to change them. Defaults: Churchill friction, a smooth wall, an orifice discharge coefficient
of 0.61, a Venturi coefficient of 0.995 (ISO 5167-4, machined), a Pelton nozzle coefficient of 0.98 with bucket
retention 0.9 and a 15° exit angle, and a ram vessel exponent of 1.2. Bad arguments throw `RangeError`; a solve
that cannot finish throws `MargoError` `'failed'`.

- **Pipes.** `pipeFlow` solves head = (exit + fL/D + ΣK) v²/2g to the last bit; `pipeLoss` gives the loss at a
  speed. `siphon` adds the crown pressure and `cavitates` once it reaches vapour pressure, with `crownLimit`, the
  highest crown at that flow (about 10.1 m for still water). `jetAfterFall` narrows a falling jet by continuity.
- **Openings.** `orificeFlow` is Torricelli's Q = Cd A √(2gh); `equalize` follows two basins (or one and a river)
  through an opening in closed form; `venturi` and `venturiFlow` convert between flow and pressure drop;
  `plugTracer` moves a dye parcel through a conduit of changing area.
- **Networks.** `solveNetwork` runs Todini and Pilati's global gradient method over reservoirs, junctions with
  demands, pipes, valves (area 0 shuts one) and pumps (h₀ - rQⁿ, with a check valve).
- **Transients.** `pipeWaveSpeed` (Korteweg with the three restraint cases), `joukowsky` (ρ a Δv), and
  `HydraulicRam`: `simulate(lift, seconds)` keeps every step, `settle(lift)` returns the repeating cycle with its
  volumes, mean flows, d'Aubuisson and Rankine efficiencies and its water balance; `ramFrameAt` samples it.
  Give `waveSpeed` instead of `compliance` to use the drive pipe's own elasticity; a fast closure then gives the
  Joukowsky surge.
- **Machines.** `peltonRunner` returns force, torque, power and efficiency at a speed, with the best and runaway
  speeds. `hingedBellows` gives the exact volume between two hinged boards and the flow through its check valves.
- **Open channels.** `hydraulicJump` (Belanger's conjugate depth, the head lost, Hager's roller length, Chow's jump
  type), `criticalDepth`, `specificEnergy`, `froudeNumber` and Manning's `normalDepth` for rectangles and
  trapezoids.

These are steady and lumped models: there is no distributed pressure-wave (method of characteristics) solver yet,
no cavitation column separation, and no `PhysicsWorld` solver wrapper; see `docs/limits.md`.

## Glacier and ice-sheet flow

`@margoengine/physics/glacier` advances grounded ice over a rectangular cell-centred bed. It solves
Glen shallow-ice flow, opens surface crevasses under tension, releases marine calving and dry icefall
volumes, and sends meltwater down a D8 surface drainage graph. Simulation runs on the world clock.

```ts
import { GlacierSolver } from '@margoengine/physics/glacier';
import { PhysicsWorld } from '@margoengine/physics/world';

using glacier = await GlacierSolver.load();
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
`GlacierSolver.load({ id, signal, threads })` accepts a field prefix (default glacier), cancellation, and
1, 2 or 4 native participants including the caller (default 1). Use a shared-memory world with helpers.
In browsers, advance that world inside an isolated Worker so helpers can join its synchronous native phases.
Dispose the solver when the world stops using it. `readNativeWork()` copies row and SIMD operation counts
from the last accepted tick. Before the first accepted tick it returns undefined.

All six published fields use layout-1 f64 cells in the solver's current origin cell. `thicknessField` and `crevasseField` are metres,
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

using gait = await GroundLocomotion.load();
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
`GroundLocomotion.load`, and register the bed before the animals. Use the same `cellSize` as the world.
The initial origin defaults to the cell passed to `world.add`. If provided, `originCell` must match it.
A fixed `Bed` supplies a surface until a declared live port is available. The remaining fallback is
`groundHeight`. Terrain callbacks return finite elevations and upward normals. Apply drive changes between steps.

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
body order and report the samples that produced the last substep. Both ports carry the current solver cell.
The loader accepts an abort signal and `threads: 1 | 2 | 4` (default 1, including the caller). Use shared
world memory for helpers and run an isolated Worker as the world owner in browsers. Dispose after the world
stops using the group. `readNativeWork()` copies accepted body, contact and paired SIMD counts and returns
undefined before the first accepted step.

## Material ageing

MaterialAgeingSolver advances rust, copper patina, wood rot, marine fouling and carbonate stone recession
on the physics clock. A wreck can use metal patches with different immersion and surface exposure.
Read a patch's remaining thickness for geometry or integrity logic and its appearance for an existing PBR material.

```ts
import { PbrMaterial } from '@margoengine/core';
import { AGEING_YEAR, MaterialAgeingSolver } from '@margoengine/physics/ageing';
import { PhysicsWorld } from '@margoengine/physics/world';

const world = new PhysicsWorld({ rate: { num: 24, den: 1 } });
using ageing = await MaterialAgeingSolver.load();
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

For changing exposure, use `MaterialAgeingSolver.load({ readExposure: true })`
and publish to its `exposureField` in the same signed origin cell. Use `writeAgeingExposure` to fill one layout-1 f64 broadcast
row or one row per patch. Row order is temperature in K, RH fraction, SO₂ and chloride in mg/(m² day),
immersed fraction, incident rain in m/s, rain pH, corrosion current in A/m², dry carbonate recession in
m/s and larval supply fraction. Fixed exposure defaults remain available before a producer's first tick.
The solver's default ID and field prefix are `ageing`. Choose a separate `id` per group in one world.
Its `stateField` has layout-1 f64 rows holding remaining and consumed metres, total and inner
coating metres, rot activity, fouled fraction and environmental seconds.

The asynchronous load uses the optional SIMD kernel. Set `threads` to 2 or 4 for a shared world running in
Node or an isolated browser worker. The default is one participant. `ageing.readNativeWork()` reports the
accepted patch counts. Dispose the solver when finished to release native helpers. The synchronous constructor
runs the same state equations in JavaScript. Both check a borrowed exposure bank in the owning memory and
retain accepted patch state when a trial is rejected.

## Iceberg capsize and calving

`@margoengine/physics/iceberg` simulates cuboid icebergs in six degrees of freedom. The pressure
on their cut waterplane drives roll and heave. Current, wind and wet-face ablation update the pose
and scale. The optional wake reader takes displaced water in surface patches with zero net volume.

```ts
import { IcebergSolver } from '@margoengine/physics/iceberg';
import { WakeSolver } from '@margoengine/physics/sea';
import { PhysicsWorld } from '@margoengine/physics/world';

using ice = await IcebergSolver.load({ threads: 1 });
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

One native participant is the default. Set `threads` to 2 or 4 in Node or an isolated browser worker with a shared-memory world. Participants update disjoint body rows. The solver admits calving and publishes signed wake, meltwater and release records in order on the caller. `readNativeWork()` copies the counts from the last accepted step. Dispose the solver once the world finishes using it.

## Grounded biped and quadruped gait

`@margoengine/physics/legged` drives a biped or quadruped from planted feet, spring support and limited ground
traction. It chooses footfall cadence and duty from the speed that was actually reached. Fast quadruped gaits use
diagonal or asymmetric contacts, and an unloaded foot applies no force.

```ts
import { LeggedLocomotion } from '@margoengine/physics/legged';
import { PhysicsWorld } from '@margoengine/physics/world';

using legs = await LeggedLocomotion.load();
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
in world snapshots. Borrowed rows must be aligned within the memory named by their port. The pose, gait, contact
and deck impulse publications carry the current signed origin. Use the accepted pose, gait and feet to place a rig.
If a late support or reaction trial fails, the preceding drive, pose, contact, gait and deck impulse stay accepted.

`load({ threads: 1 })` defaults to one participant. Choose two or four with shared world memory in Node or
an isolated browser worker. The optional native route evaluates independent bodies and their stance work.
`readNativeWork()` reports the last accepted step and per-participant counts. Stop advancing the world before
disposing the solver. [Legged error remedies](https://margoengine.com/errors#legged)

## Pack ice and floes

Use `@margoengine/physics/pack-ice` for freely drifting sea-ice disks that collide, raft thin ice and turn
thicker broken ice into pressure ridges. The state keeps the volume of level, rafted and ridged ice.
The optional Water ice entry can display those poses on a sampled sea.

```ts
import { PackIceSolver } from '@margoengine/physics/pack-ice';
import { PhysicsWorld } from '@margoengine/physics/world';

using pack = await PackIceSolver.load({ threads: 1 });
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

`PackIceSolver.load({ threads })` defaults to one participant. Use two or four in Node or an isolated browser worker with a shared-memory world. Each participant updates its own planar drag and translation rows. Grid insertion, contacts and vessel impulses stay ordered. `readNativeWork()` reports the last accepted step and per-participant drift counts. Dispose the solver after the world is finished with it.

## Ductile crashworthiness (`@margoengine/physics/crush`)

`resolveCrush` inverts a measured normal force-displacement curve to find the peak force, permanent stroke, and energy left for rebound. Use newtons, metres, kilograms, and metres per second. Positive hardening raises the yield force as the member permanently shortens. After the measured stroke is used, a stiffer elastic backing supports the load.

```ts
import { resolveCrush } from '@margoengine/physics/crush';

const curve = { stiffness: 400, yieldForce: 40, stroke: 0.4 };
const result = resolveCrush(curve, 4, 2);
if (Math.abs(result.absorbedEnergy - 6) > 1e-12) throw new Error('Expected 6 J of permanent work');
```

For a short square tube designed to fold under axial compression, `squareTubeCrushMaterial` builds a
mean load curve from the outer width, thickness, length, Young's modulus, proof stress and ultimate
tensile strength. Use the returned material in a patch or evaluate it at a displacement with
`resolveCrushStroke`. The optional prior permanent stroke starts a subsequent load without repeating its
permanent work. The curve represents the mean folding force over successive folds.

```ts
import { resolveCrushStroke, squareTubeCrushMaterial } from '@margoengine/physics/crush';

const tube = squareTubeCrushMaterial({
  width: 0.0381, thickness: 0.00159, length: 0.2032,
  young: 69e9, yieldStress: 118e6, tensileStrength: 152e6,
});
const loaded = resolveCrushStroke(tube, 0.1);
const energyAt100mm = loaded.absorbedEnergy + loaded.elasticEnergy;
if (energyAt100mm < 900 || energyAt100mm > 1000) throw new Error('Expected progressive tube folding work');
```

Use a `CrushEnvelope` when a crush zone has several trigger peaks and lower folding loads.
Give the first point at `force / stiffness` and subsequent points in increasing total stroke.
Each point must leave more permanent shortening after elastic release than the previous
one. The final point starts the elastic backing. The default backing stiffness is the
unloading stiffness. Use `resolveCrushEnvelopeStroke` for guided compression or
`resolveCrushEnvelope` for the turning point of one normal impact.

```ts
import { resolveCrushEnvelope, resolveCrushEnvelopeStroke } from '@margoengine/physics/crush';

const staged = { stiffness: 1e5, loading: [
  { stroke: 0.02, force: 2000 }, { stroke: 0.07, force: 4500 }, { stroke: 0.15, force: 3500 },
] };
const loading = resolveCrushEnvelopeStroke(staged, 0.12);
const impact = resolveCrushEnvelope(staged, 100, 3);
if (loading.force >= 4500 || impact.peakForce !== 4500) throw new Error('Expected a trigger and falling load');
```

For live progressive contact, add a station to `envelopePatches` with this `material`
and set `response: 'continuous'`. Omit the support and radius for a live terrain station. In `new CrushSolver({ rate })`, level 0 is 60 Hz and each
increase doubles that rate up to level 7 at 7,680 Hz. Use the same fixed timestep on
the rigid solver and run crush before rigid in the same staggered group. Use a higher rate level when a falling load changes too steeply within a step.
The existing one-event impact path also accepts the envelope.

```ts
import { Physics } from '@margoengine/physics';
import { CrushSolver } from '@margoengine/physics/crush';
import { PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';

await Physics.load();
const gravity = [0, 0, 0] as const;
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(false) });
using physics = new Physics(null, { arena: world.arena, gravity, fixedTimestep: 1 / 120 });
const body = physics.addBody(null, {
  linearVelocity: [3, 0, 0],
  colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], mass: 100, sensor: true },
});
const crush = new CrushSolver({ rate: 1 });
const bodyCapacity = physics.kernel.capacity;
world.add(new RigidSolver(), { physics, capacity: bodyCapacity });
world.add(crush, { bodyCapacity, patches: [], envelopePatches: [{
  body: body.row, anchor: [0.5, 0, 0], normal: [1, 0, 0], radius: 0.5,
  support: { point: [0.5, 0, 0] }, response: 'continuous',
  material: { stiffness: 1e5, loading: [
    { stroke: 0.02, force: 2000 }, { stroke: 0.07, force: 4500 }, { stroke: 0.15, force: 3500 },
  ] },
}] });
world.couple([crush.id, 'rigid'], 'staggered');
world.advance(10);
if (crush.read(0).permanentStroke <= 0.025) throw new Error('Expected to fold beyond the trigger');
```

[Full-scale rail compression comparison](../../docs/whitepaper/reproduce.md#break-03-staged-rail-crush)
[Independent NCAP road-car pulse](../../docs/whitepaper/reproduce.md#break-03-independent-ncap-road-car-pulse)

Pair `CrushSolver.withContactInertia(channel)` with `HullSolver.withContactInertia(channel)`
to include the hull's instantaneous exterior added mass and carried water in station contact.
Create the shared channel with `crushInertiaChannel()` (default name `wet-crush`). Tell
the world to run hull, crush and rigid in that order in one staggered 60 Hz group. Use the
rigid capacity for the crush solver. Unmapped bodies and bodies with locked angular axes
use the ordinary rigid contact inertia.

```ts
import { Physics } from '@margoengine/physics';
import { CrushSolver, crushInertiaChannel } from '@margoengine/physics/crush';
import { HullSolver } from '@margoengine/physics/seakeeping';
import { PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';

await Physics.load();
const gravity = [0, 0, 0] as const;
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(false) });
using physics = new Physics(null, { arena: world.arena, gravity });
const channel = crushInertiaChannel();
const hull = HullSolver.withContactInertia(channel);
const crush = CrushSolver.withContactInertia(channel);
const vessel = physics.addBody(null, {
  linearVelocity: [0, 2, 0],
  colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], mass: 500, sensor: true },
});
const mesh = {
  vertices: [-0.5,-0.5,-0.5, 0.5,-0.5,-0.5, 0.5,0.5,-0.5, -0.5,0.5,-0.5,
    -0.5,-0.5,0.5, 0.5,-0.5,0.5, 0.5,0.5,0.5, -0.5,0.5,0.5],
  indices: [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,4,7, 0,7,3, 1,2,6, 1,6,5, 0,1,5, 0,5,4, 3,7,6, 3,6,2],
};
const bodyCapacity = physics.kernel.capacity;
world.add(new RigidSolver(), { physics, capacity: bodyCapacity });
world.add(hull, {
  hulls: [{ row: vessel.row, mesh, compartments: [{ mesh, permeability: 1, water: 0.25 }] }],
  sea: { density: 1000, elevation: () => 0, pressure: () => 0 }, gravity,
  addedMass: false, radiation: false, rollDamping: false, drag: false, slamming: false,
});
world.add(crush, { bodyCapacity, patches: [{
  body: vessel.row, anchor: [0, 0.5, 0], normal: [0, 1, 0], radius: 0.4,
  support: { point: [0, 0.5, 0] }, material: { stiffness: 80e3, yieldForce: 1e9, stroke: 1 },
}] });
world.couple([hull.id, crush.id, 'rigid'], 'staggered');
world.advance(1);
if (Math.abs(crush.read(0).impulse - 3000) > 0.001) throw new Error('Expected elastic rebound with 250 kg of carried water');
```

[Wet contact method and checks](../../docs/whitepaper/reproduce.md#break-03-wet-contact-inertia)

The staged response predicts compression work and stroke in two independently
measured foam-panel model-ship tests using the published wet inertia.
[Held-out model-ship comparison](../../docs/whitepaper/reproduce.md#break-03-held-out-model-ship-contacts)

Use `resolveGirder` to bend a cross section made of plate strips and stiffeners. Give each strip its
area, offset and stress–strain curve, including the unloaded origin. The solver finds the axial
strain that balances the prescribed force. Pass the prior `referenceStrain` as `previousStrain` to
follow a branch through softening. Omit `axialForce` for pure bending. The result gives the moment,
neutral axis and per-strip state, or is `undefined` when the supplied curves cannot balance the force.

```ts
import { resolveGirder } from '@margoengine/physics/crush';

const steel = [
  { strain: -0.00125, stress: -250e6 }, { strain: 0, stress: 0 }, { strain: 0.00125, stress: 250e6 },
];
const section = [-0.5, 0.5].map(offset => ({ offset, area: 0.01, curve: steel }));
const bent = resolveGirder(section, 0.001);
if (!bent || Math.abs(bent.bendingMoment - 1e6) > 1e-6) throw new Error('Expected the elastic section moment');
```

Use `GirderJointSolver` to join two independently simulated rigid parts at a section. Set their
body-local anchors and the first body's bending axis in the aligned rest pose. Give the section's
gauge length, anchor stiffness, tensile failure strain and plate or stiffener curves. While intact,
the anchors transmit three-dimensional force and the section transmits its bending couple. When a
fiber reaches the specified strain, the joint releases permanently. The authored bodies keep their
own colliders and motion. `read(index)` copies signed curvature, resisting moment, peak tensile
strain, anchor separation and the failure flag. The `seamField` publishes layout-1 f64 rows in
the same order with the reference axial strain inserted between moment and peak tensile strain.

```ts
import { Physics } from '@margoengine/physics';
import { GirderJointSolver } from '@margoengine/physics/crush';
import { PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';

await Physics.load();
const gravity = [0, 0, 0] as const;
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(false) });
using physics = new Physics(null, { arena: world.arena, gravity });
const colliders = { shape: 'box', halfExtents: [0.25, 0.25, 0.25], mass: 4, sensor: true } as const;
const fore = physics.addBody(null, { position: [-0.25, 0, 0], colliders });
const aft = physics.addBody(null, { position: [0.25, 0, 0], colliders });
const curve = [{ strain: -0.2, stress: -400 }, { strain: 0, stress: 0 }, { strain: 0.2, stress: 400 }];
const fibers = [-0.1, 0.1].map(offset => ({ offset, area: 0.01, curve }));
const seam = new GirderJointSolver();
const bodyCapacity = physics.kernel.capacity;
world.add(new RigidSolver(), { physics, capacity: bodyCapacity });
world.add(seam, { bodyCapacity, joints: [{
  first: { body: fore.row, anchor: [0.25, 0, 0] }, second: { body: aft.row, anchor: [-0.25, 0, 0] },
  axis: [0, 0, 1], gaugeLength: 0.6, anchorStiffness: 900, failureStrain: 0.045, fibers,
}] });
world.couple(['rigid', seam.id], 'staggered');
fore.addTorque([0, 0, -0.8]);
aft.addTorque([0, 0, 0.8]);
world.advance(60);
if (!seam.read(0).broken) throw new Error('Expected the girder seam to release under differential bending');
```

Pass `GirderJointSolver.seamField` as the fourth argument to `HullSolver` and give the compartment
opening a zero-based `girderJoint` index. The authored rectangle starts shut and opens permanently
when that seam releases. Each rigid half can carry its own watertight mesh and compartments.

```ts
import { Physics } from '@margoengine/physics';
import { GirderJointSolver } from '@margoengine/physics/crush';
import { HULL_BREACHES_FIELD, HullSolver } from '@margoengine/physics/seakeeping';
import { PhysicsWorld, RigidSolver, regionWords, worldMemory } from '@margoengine/physics/world';

await Physics.load();
const gravity = [0, -9.81, 0] as const;
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(false) });
using physics = new Physics(null, { arena: world.arena, gravity });
const mesh = {
  vertices: [-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1].map(v => 0.2 * v),
  indices: [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,4,7, 0,7,3, 1,2,6, 1,6,5, 0,1,5, 0,5,4, 3,7,6, 3,6,2],
};
const makeHalf = (x: number) => physics.addBody(null, {
  position: [x, 0.1, 0], colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], mass: 16, sensor: true },
});
const fore = makeHalf(-0.2);
const aft = makeHalf(0.2);
const seam = new GirderJointSolver();
const hull = new HullSolver('hull', undefined, undefined, seam.seamField);
const bodyCapacity = physics.kernel.capacity;
const curve = [{ strain: -0.2, stress: -400 }, { strain: 0, stress: 0 }, { strain: 0.2, stress: 400 }];
world.add(new RigidSolver(), { physics, capacity: bodyCapacity });
world.add(seam, { bodyCapacity, joints: [{
  first: { body: fore.row, anchor: [0.2, 0, 0] }, second: { body: aft.row, anchor: [-0.2, 0, 0] },
  axis: [0, 0, 1], gaugeLength: 0.6, anchorStiffness: 900, failureStrain: 0.045,
  fibers: [-0.1, 0.1].map(offset => ({ offset, area: 0.01, curve })),
}] });
world.add(hull, { hulls: [
  { row: fore.row, mesh, compartments: [{ mesh, permeability: 1 }], openings: [{
    from: 0, to: 'outside', centre: [0, -0.2, 0], normal: [0, -1, 0], width: 0.02, height: 0.02, girderJoint: 0,
  }] },
  { row: aft.row, mesh },
], sea: { elevation: () => 0 }, gravity, addedMass: false, radiation: false });
world.couple(['rigid', seam.id, hull.id], 'staggered');
world.advance(1);
aft.setRotation([0, 0, Math.sin(0.18), Math.cos(0.18)]);
world.advance(4);
const port = world.fields.port(HULL_BREACHES_FIELD.name);
if (!port || !seam.read(0).broken || regionWords(world.memory, port.region)[10]! >= 0)
  throw new Error('Expected water to enter the fractured fore compartment');
```

Use `resolvePlateBuckling` for the first elastic mode of a simply supported rectangular plate.
Specify dimensions, Young's modulus, Poisson's ratio (default `0.3`) and a signed initial crest
(default `0`, in metres). Pass the end shortening in metres. Optional rest-plane XY pairs
produce deformed XYZ positions and unit normals for the existing mesh indices.

```ts
import { resolvePlateBuckling } from '@margoengine/physics/crush';

const plate = { length: 0.6, width: 0.3, thickness: 0.003, young: 200e9 };
const loaded = resolvePlateBuckling(plate, 0.0014, [0, 0.15, 0.15, 0.15, 0.3, 0.15]);
if (loaded.halfWaves !== 2 || !loaded.surface || loaded.surface.positions[5] <= 0) {
  throw new Error('Expected a nonzero elastic plate buckle');
}
```

Use `CircularPlateIndentation` for a thin circular plate pushed out of its plane by a smooth
sphere at its centre. Supply the held radius, undeformed thickness, sphere radius and the
uniaxial true-stress coefficients from a tensile coupon. The solver prepares a table for the
intact loading branch and its first force peak. `read(stroke, xy)` returns the normal force,
work, contact radius and optional deformed XYZ samples and normals. When the stroke reaches
localization, `fractured` is true and the shape and work stay at that point. Use the intact
branch for quasi-static indentation before a localized tear.

```ts
import { CircularPlateIndentation } from '@margoengine/physics/crush';

const hullPlate = new CircularPlateIndentation({
  radius: 0.1114, thickness: 0.001, indenterRadius: 0.025,
  strength: 497e6, hardening: 0.19,
});
const dent = hullPlate.read(0.03, [0, 0, 0.04, 0, 0.1114, 0]);
if (!dent.force || !dent.surface || dent.surface.positions[2] !== dent.stroke) {
  throw new Error('Expected a deformed steel membrane with an intact reaction');
}
```

For a distributed sheet, load `CrushShellSolver` and pass its rest positions, consistently wound
triangles and uniform material. `pinned` fixes vertices at their rest offsets. It defaults to an
unconstrained sheet, with all initial velocities zero. The world supplies gravity. Set vertex loads
in newtons with `setForce`; they hold until replaced. The solver publishes xyz position offsets as
a layout-1 f64 mesh field and copies live positions, velocities and triangle indices through
`readMesh`. `supportReaction` gives the endpoint reaction on a fixed vertex. `readFace` gives
local second Piola–Kirchhoff stress and plastic state. `readBudget` gives the work and energy
ledger in joules. Omit `hardeningModulus` for ideal plasticity.

Choose `threads: 1` (the default), `2` or `4` on the shell loader. The multi-participant route uses a shared world in Node or a cross-origin-isolated browser worker. `readNativeWork()` reports the previous accepted step by participant. Use `using` to release native helpers after the world finishes. Malformed rigid input gives a [coded error](https://margoengine.com/errors#ductile-crush) and preserves the last accepted damage and impulses.

```ts
import { CrushShellSolver } from '@margoengine/physics/crush';
import { PhysicsWorld } from '@margoengine/physics/world';

using shell = await CrushShellSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, 0, 0] });
world.add(shell, {
  positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
  triangles: [[0, 1, 2]],
  pinned: [0, 2],
  material: { thickness: 0.015, density: 7800, youngModulus: 200e9, poissonRatio: 0.3, yieldStress: 350e6 },
});
shell.setForce(1, [125000, 0, 0]);
world.advance(1);
if (shell.readMesh().positions[3]! <= 1) throw new Error('Expected the steel sheet to extend');
```

The optional Wasm code uses the same arena as the world and loads on demand through
`CrushShellSolver.load({ signal })`. The default solver id is `crush-shell`. Substeps follow the rest
stiffness and lumped vertex masses. Set `resolution` to a positive integer to refine them from the
default 1. The explicit integrator accepts at most 8,192 substeps per tick. Choose a mesh and
resolution within that limit and test convergence for the applied load.
[Shell method and checks](../../docs/whitepaper/reproduce.md#break-03-distributed-ductile-shell)

For rolled metal, set `anisotropy` with three uniaxial width-to-thickness plastic strain
ratios `r0`, `r45` and `r90`. Set `yieldStress` from the rolling-direction coupon. Supply
the rest-space `rollingDirection`, with a nonzero projection onto each face. The resulting
Hill-48 stresses are reported in the projected rolling and transverse material directions.
Omit `anisotropy` for the standard isotropic yield law.

```ts
import { CrushShellSolver } from '@margoengine/physics/crush';
import { PhysicsWorld } from '@margoengine/physics/world';

const shell = await CrushShellSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, 0, 0] });
world.add(shell, {
  positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
  triangles: [[0, 1, 2]],
  pinned: [0, 2],
  material: {
    thickness: 0.002, density: 2660, youngModulus: 70e9, poissonRatio: 0.33,
    yieldStress: 119.704e6, hardeningModulus: 150.4e6 * 10.7,
    anisotropy: { rollingDirection: [1, 0, 0], r0: 0.49, r45: 0.59, r90: 0.51 },
  },
});
shell.setForce(1, [140000, 0, 0]);
world.advance(2);
if (shell.readFace(0).equivalentPlasticStrain <= 0) throw new Error('Expected this rolled sheet to yield');
```

[Rolled-sheet material source and held-out tests](../../docs/whitepaper/reproduce.md#break-03-rolled-sheet-yield)

To load a sheet with a moving rigid sphere, call `CrushShellSolver.loadRigid()`. Register a
centered sphere, give its radius and effective Hertz contact modulus, and let the shell own the
pair's collision. Match the rigid clock to the shell's `rate`. Add the rigid solver before the
shell and put the shell first in their staggered group. Use at least two native rigid substeps
for moving spheres. `readSphereContact` reports the integrated rigid impulse, recoverable
interface energy and compression at the last substep. Set the sphere's `friction` coefficient
(default 0) for tangential sticking and sliding. Read angular impulse and the interval's lost
kinetic energy with `readSphereFriction`.

```ts
import { Physics } from '@margoengine/physics';
import { CrushShellSolver } from '@margoengine/physics/crush';
import { PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';

await Physics.load();
const gravity = [0, 0, 0] as const;
const world = new PhysicsWorld({ rate: { num: 480, den: 1 }, gravity, memory: worldMemory(false) });
using physics = new Physics(null, { arena: world.arena, gravity, fixedTimestep: 1 / 480, substeps: 4 });
const tool = physics.addBody(null, {
  position: [0.3, 0.2, 0.13], linearVelocity: [0.7, 0, -0.8],
  colliders: { shape: 'sphere', radius: 0.125, mass: 14, sensor: true },
});
const shell = await CrushShellSolver.loadRigid({ rate: 3 });
world.add(new RigidSolver(), { physics, capacity: physics.kernel.capacity });
world.add(shell, {
  positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
  triangles: [[0, 1, 2]],
  material: { thickness: 0.015, density: 7800, youngModulus: 200e9, poissonRatio: 0.3, yieldStress: 350e6 },
  spheres: [{ body: tool.row, radius: 0.125, contactModulus: 7e6, friction: 0.28 }],
  contactManifold: true,
});
world.couple([shell.id, 'rigid'], 'staggered');
world.advance(1);
if (tool.linearVelocity[2]! <= -0.8) throw new Error('Expected the compliant contact to slow the sphere');
if (shell.readSphereFriction(0).dissipatedEnergy <= 0) throw new Error('Expected energy loss from sliding contact');
```

By default contact selects the closest live triangle within one sphere radius plus half the thickness.
Use `contactManifold: true` on folded or disconnected sheets to apply simultaneous contacts
at each local distance minimum. Shared edges and vertices produce one contact each.
The contact reading sums interface energies and reports the deepest compression.
Set `cellSize` if the rigid and shell solvers use different origin cells.
[Normal contact checks](../../docs/whitepaper/reproduce.md#break-03-distributed-sphere-contact) · [Friction method and checks](../../docs/whitepaper/reproduce.md#break-03-distributed-shell-friction) · [Manifold proof](../../docs/whitepaper/reproduce.md#break-03-folded-shell-contact)

Give `CrushShellSolver` cohesive `seams` where two pieces meet along a prescribed fracture
line. Each side is a separate boundary edge with matching rest positions in the same
endpoint order. The interface loses stiffness irreversibly as it takes work from relative
motion. After both sampled points release, the edges move freely and `readSeam` reports the
current area between them. The triangles already index separate pieces, so use the live
mesh directly when drawing the opening.

```ts
import { CrushShellSolver } from '@margoengine/physics/crush';
import { PhysicsWorld } from '@margoengine/physics/world';

const shell = await CrushShellSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, 0, 0] });
world.add(shell, {
  positions: [[-1, 0, 0], [0, 0, 0], [0, 1, 0], [0, 0, 0], [1, 0, 0], [0, 1, 0]],
  triangles: [[0, 1, 2], [3, 4, 5]],
  velocities: [[-0.8, 0, 0], [-0.8, 0, 0], [-0.8, 0, 0], [0.8, 0, 0], [0.8, 0, 0], [0.8, 0, 0]],
  material: { thickness: 0.015, density: 7800, youngModulus: 200e9, poissonRatio: 0.3, yieldStress: 350e6 },
  seams: [{ sides: [[1, 2], [3, 5]], stiffness: 4e5, peakTraction: 12e3, toughness: 600 }],
});
world.advance(18);
if (!shell.readSeam(0).broken) throw new Error('Expected the loaded seam to release');
```

Stiffness is in Pa/m, peak traction in Pa, and toughness in J/m² of undeformed section.
Set those from the bounded joint material response. The seam's recoverable and irreversible
energies are in `readSeam`; `readBudget` continues to report the bulk sheet terms.
[Seam method and checks](../../docs/whitepaper/reproduce.md#break-03-cohesive-sheet-seams)

Use `CrushShellSolver.loadWithApertures()` to publish released edges and connect them to
`HullSolver.withShellApertures(shell.apertureField)`. Set an opening's `shellSeam` to its
zero-based seam index. The live quadrilateral supplies area, depth and the breach position.
The opening's `normal` selects the outward side for the outflow field. Use matching origin
cells or give the consumer the common `cellSize` in metres. To combine this with rigid sphere
contact, call the shell loader with `{ rigid: { rate } }`.

On a stationary fixed hull, use `loadWithAperturePressure` to return the previous
flooding step's water levels and compartment pressure to the selected shell
faces. Give `HullSolver.withShellPressure` both shell fields and
assign faces through `pressurePatches`. Wind the panel faces outward. The
closed panel receives hydrostatic load before its seam releases. After release,
the live aperture controls flooding and air compression. The shell applies
the resulting differential pressure to its deformed faces. Use gravity along
negative Y, the same solver rate, and the order shell, hull, rigid.

```ts
import { Physics } from '@margoengine/physics';
import { CrushShellSolver } from '@margoengine/physics/crush';
import { HULL_BREACHES_FIELD, HullSolver } from '@margoengine/physics/seakeeping';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '@margoengine/physics/world';

await Physics.load();
const gravity = [0, -9.81, 0] as const;
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(false) });
using physics = new Physics(null, { arena: world.arena, gravity });
const body = physics.addBody(null, {
  type: 'fixed',
  colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], mass: 500, sensor: true },
});
const shell = await CrushShellSolver.loadWithAperturePressure();
const hull = HullSolver.withShellPressure(shell.apertureField, shell.aperturePressureField);
const vertices = Float64Array.from(
  [-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1], value => value * 0.5,
);
const mesh = { vertices, indices: [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,4,7, 0,7,3,
  1,2,6, 1,6,5, 0,1,5, 0,5,4, 3,7,6, 3,6,2] };
world.add(new RigidSolver(), { physics, capacity: physics.kernel.capacity });
world.add(shell, {
  positions: [[-0.3,-0.4,0.5], [0,-0.4,0.5], [0,-0.2,0.5], [0,-0.4,0.5], [0.3,-0.4,0.5], [0,-0.2,0.5]],
  triangles: [[0,1,2], [3,4,5]],
  pinned: [0, 4],
  velocities: [[0,0,0], [-1.6,0,0], [-1.6,0,0], [1.6,0,0], [0,0,0], [1.6,0,0]],
  material: { thickness: 0.015, density: 7800, youngModulus: 200e6, poissonRatio: 0.3, yieldStress: 350e3 },
  seams: [{ sides: [[1,2],[3,5]], stiffness: 4e5, peakTraction: 12e3, toughness: 600 }],
  pressurePatches: [{ seam: 0, faces: [0, 1] }],
  recordWork: true,
});
world.add(hull, {
  hulls: [{ row: body.row, mesh, compartments: [{ mesh, permeability: 1 }], openings: [{
    from: 0, to: 'outside', centre: [0,-0.25,0.5], normal: [0,0,1], width: 0.001, height: 0.001, shellSeam: 0,
  }] }],
  sea: { density: 1000, elevation: () => 0, pressure: (_x, y) => Math.max(0, -9810 * y) },
});
world.couple([shell.id, hull.id, 'rigid'], 'staggered');
world.advance(1);
for (let frame = 2; frame <= 16 && !shell.readSeam(0).broken; frame++) world.advance(frame);
const aperture = world.fields.port(HULL_BREACHES_FIELD.name)!;
if (Number(regionWords(world.memory, aperture.region)[10]) >= 0) throw new Error('Expected flooding through the seam');
const head = world.fields.port(shell.aperturePressureField.name)!;
if (Number(regionWords(world.memory, head.region)[3]) <= 0) throw new Error('Expected air compression in the flooded compartment');
if (shell.readWork().pressureFaceVisits === 0) throw new Error('Expected native pressure visits');
```

[Flooding and return-pressure checks](../../docs/whitepaper/reproduce.md#break-03-hydrostatic-shell-feedback)

Use `recordWork: true` to call `readWork()` after a completed shell interval.
It reports native substeps, membrane and hinge evaluations, seam quadrature
points, sphere face checks and pressure face visits.
[Deterministic work counts](../../docs/whitepaper/reproduce.md#break-03-native-shell-work)

The shell aperture port uses layout 1, with area in square metres followed by four
xyz vertices in metres in the port's origin cell. `SHELL_APERTURE_WORDS` gives the row width.
[Aperture method and checks](../../docs/whitepaper/reproduce.md#break-03-live-shell-aperture)

On moving bodies, add the circular plate to `CrushSolver.indentationPatches`. Choose the
body-local plate anchor, normal and support point as with ordinary patches. The station
absorbs the available normal energy up to localization. An intact dent stays plastically
deformed and can support a later load up to its retained loading force. Permanent rupture
releases the normal reaction and sets the existing seal-loss field to `1`. Use
`readIndentation(index, xy)` to render the retained dent. Its index follows the ordinary
and ground patches, and can also drive a compartment opening's `crushPatch` index.

```ts
import { Physics } from '@margoengine/physics';
import { CrushSolver } from '@margoengine/physics/crush';
import { PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';

await Physics.load();
const gravity = [0, 0, 0] as const;
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(false) });
using physics = new Physics(null, { arena: world.arena, gravity });
const hull = physics.addBody(null, {
  position: [-0.405, 0, 0], linearVelocity: [2.2, 0, 0],
  colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], mass: 400, sensor: true },
});
const crush = new CrushSolver();
const bodyCapacity = physics.kernel.capacity;
world.add(new RigidSolver(), { physics, capacity: bodyCapacity });
world.add(crush, { bodyCapacity, patches: [], indentationPatches: [{
  body: hull.row, anchor: [0.2, 0, 0], normal: [1, 0, 0], radius: 0.1114,
  support: { point: [-0.2, 0, 0] },
  indentation: { radius: 0.1114, thickness: 0.001, indenterRadius: 0.025, strength: 497e6, hardening: 0.19 },
}] });
world.couple(['rigid', crush.id], 'staggered');
world.advance(3);
const dent = crush.readIndentation(0, [0, 0, 0.05, 0]);
if (!dent.fractured || crush.read(0).sealLoss !== 1)
  throw new Error('Expected the native plate contact to open the seal and retain its dent');
```

`CrushSolver` couples a list of known contact patches to a `RigidSolver`, including fixed barriers. Use body-local anchors for moving patches. Fix a barrier in the zero cell or give its cell and set `cellSize`. Match `bodyCapacity` to the rigid port and register both solvers in a `staggered` group. Filter only the contact pair whose normal response belongs to the crush patch. A dedicated rig can use a sensor-only collider when the patch handles every contact. Keep other rigid contacts enabled in a mixed scene. The normal and point impulses are equal and opposite on moving pairs. A patch that stays compressed after
impact continues to support load. It uses its `backingStiffness` and critical damping of the effective
normal mass. This contact carries reciprocal impulses without creating a new material event. The durable
damage fields record the prior material event and accumulated crush work. The descriptor `damageField` publishes layout-1 f64 rows in input order. Each row contains permanent stroke (m), cumulative absorbed work (J), last peak stroke (m), force (N), impulse (N s), elastic work (J), seal loss (0–1), and impact count. `read()` copies the corresponding typed record.

Set a patch's `friction` to the measured dry friction coefficient of the pair. It defaults to `0`.
Friction uses the normal impulse from each tick to limit the tangential impulse. It sticks when the
point can stop slipping within that limit and slides otherwise. The impulse accounts for both
surfaces' angular inertia. The damage ledger continues to report permanent material work.

The default `response: 'impact'` solves the loading and rebound of a discrete event. Set
`response: 'continuous'` to integrate the material at each contact step. Use it where a member
keeps yielding under a sustained push. Its most recent contact's peak fields retain the maxima
from that contact, and `impulse` sums the normal impulse through the contact. Permanent stroke
and work survive unloading and reach the linked compartment aperture when the seal fails.

For grounding, give `CrushSolver` the live `TerrainBed` grid shape and author the hull stations
in `groundPatches`. Their damage records follow the ordinary patches. Each station finds
the first bed triangle reached by its motion during the
step. The triangle supplies the support direction and the station's outward normal selects
which side of the hull can take the load. Put this reaction on the stations whose colliders
use sensors or collision filtering for the bed. Set `cellSize` when the bed and the rigid bodies
use different cells. The ground patch works with both contact modes and uses the existing
friction, seal and plate options.

```ts
import { Physics } from '@margoengine/physics';
import { CrushSolver } from '@margoengine/physics/crush';
import { TerrainBed } from '@margoengine/physics/earth';
import { PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';

await Physics.load();
const gravity = [0, 0, 0] as const;
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(false) });
using physics = new Physics(null, { arena: world.arena, gravity });
const hull = physics.addBody(null, {
  position: [-0.05, 0.04, 0], linearVelocity: [3, -1, 0],
  colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1], mass: 4, sensor: true },
});
const terrain = { columns: 4, rows: 2, width: 4, depth: 2, centre: [0, 0] as const };
const crush = new CrushSolver({ terrain });
const bodyCapacity = physics.kernel.capacity;
world.add(new TerrainBed(), { ...terrain, elevations: x => 0.5 * x });
world.add(new RigidSolver(), { physics, capacity: bodyCapacity });
world.add(crush, { bodyCapacity, patches: [], groundPatches: [{
  body: hull.row, anchor: [0, 0, 0], normal: [0, -1, 0],
  material: { stiffness: 800, yieldForce: 16, stroke: 0.45 }, friction: 0.2,
}] });
world.couple(['bed', 'rigid', crush.id], 'staggered');
world.advance(6);
if (crush.read(0).absorbedEnergy <= 0) throw new Error('Expected work in the grounding station');
```

```ts
import { Physics } from '@margoengine/physics';
import { CrushSolver } from '@margoengine/physics/crush';
import { PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';

await Physics.load();
const gravity = [0, 0, 0] as const;
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(false) });
using physics = new Physics(null, { arena: world.arena, gravity });
const cart = physics.addBody(null, {
  position: [-0.5, 0, 0], linearVelocity: [2, 0, 0.5],
  colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], mass: 4 },
});
const crush = new CrushSolver();
const bodyCapacity = physics.kernel.capacity;
world.add(new RigidSolver(), { physics, capacity: bodyCapacity });
world.add(crush, { bodyCapacity, patches: [{
  body: cart.row, anchor: [0.2, 0, 0], normal: [1, 0, 0], radius: 0.12,
  support: { point: [-0.2, 0, 0] }, material: { stiffness: 400, yieldForce: 40, stroke: 0.4 },
  friction: 0.25, response: 'continuous',
}] });
world.couple(['rigid', crush.id], 'staggered');
world.advance(12);
if (crush.read(0).impacts !== 1) throw new Error('Expected one barrier contact');
if (cart.linearVelocity[2] >= 0.5) throw new Error('Expected friction to slow the slide');
```

Attach a `plate` to a continuous patch to sample its live geometry. `readPlate` uses the current
stroke under pressure and the retained stroke after release. Pass the rest XY pairs in the plate's
local frame and give the sampled positions and normals to the renderer. If the span is exhausted,
the reading still provides `stroke` and `sealLoss` and no longer includes a buckling surface.

```ts
import { Physics } from '@margoengine/physics';
import { CrushSolver } from '@margoengine/physics/crush';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';

await Physics.load();
const gravity = [0, 0, 0] as const;
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity });
using physics = new Physics(null, { arena: world.arena, gravity });
const platen = physics.addBody(null, {
  position: [-0.3986, 0, 0],
  colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], mass: 5e6, sensor: true },
});
const crush = new CrushSolver();
const capacity = physics.kernel.capacity;
world.add(new RigidSolver(), { physics, capacity });
world.add(crush, { bodyCapacity: capacity, patches: [{
  body: platen.row, anchor: [0.2, 0, 0], normal: [1, 0, 0], radius: 0.12, response: 'continuous',
  support: { point: [-0.2, 0, 0] }, material: { stiffness: 300e6, yieldForce: 80e3, stroke: 0.025 },
  plate: { length: 0.6, width: 0.3, thickness: 0.003, young: 200e9 },
}] });
world.couple(['rigid', crush.id], 'staggered');
world.advance(1);
const { buckling } = crush.readPlate(0, [0.15, 0.15, 0.45, 0.15]);
if (!buckling?.surface || buckling.surface.positions[2] <= 0) throw new Error('Expected the loaded plate crest');
```

## Thin films on glass and ground

Use `@margoengine/physics/thin-film` for a thin layer of water on a backing surface. The solver tracks
rainfall, impacts, gravity, pressure, viscous shear, capillarity, drying and liquid leaving an open edge.
The first two axes define the patch in metres. Set its origin and tangents in a rigid body's local frame
and pass a body row to move it with a window or deck.

`ThinFilmSolver.load({threads, signal})` defaults to one native participant. Choose `threads: 2` or `4`
with a shared-memory world to split the existing implicit film matrix across the caller and helpers.
Run multiple participants in Node or a cross-origin-isolated browser worker. `workCounts()` copies the matrix work of
the last accepted step. Keep the solver alive while the world uses it, and release it with `using`.

Out-of-range settings and rejected steps give a [coded error](https://margoengine.com/errors#thin-film-flow)
with a fix. A numerical failure preserves accepted depths, drainage, loads, wave outputs and timed drops.

```ts
import { PhysicsWorld } from '@margoengine/physics/world';
import { ThinFilmSolver } from '@margoengine/physics/thin-film';

using film = await ThinFilmSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(film, {
  cells: [4, 6],
  spacing: 0.04,
  u: [1, 0, 0],
  v: [0, -1, 0],
  depth: 0.0002,
  wetting: { contactAngle: 0.35, precursorDepth: 0.00005 },
  wettingAngleMap: Array.from({ length: 24 }, (_, i) => (i % 4 < 2 ? 0.25 : 0.45)),
  contactAngleHysteresis: [0.15, 0.55],
  drains: [false, false, false, true],
});
world.advance(60);
const surface = film.surfaceGeometry();
console.log(film.budget.dripped, film.sample(0, 5).depth, surface.indices.length);
console.log(film.workCounts().threads); // 1 with the default load options
```

Set `wetting` for a partially wetting surface. Enter the equilibrium contact angle in radians and
include the resolved precursor layer in the initial depth. The layer contributes to the same water
budget as the rest of the film. Omit `wetting` to run without disjoining pressure.
For patterned glass, give `wettingAngleMap` one row-major value per cell. Use `undefined`
at a cell to apply the backing's default `contactAngle`.

Set `contactAngleHysteresis: [receding, advancing]` to retain a shallow drop until
gravity, pressure or air shear overcomes its contact-line resistance. Angles are in
radians and must bracket every equilibrium angle on the backing. Supply the wetting
precursor and omit the older scalar `pinning` option. Hysteresis is off by default.

Set `suspended: true` on the underside of a panel with its normal pointing into the liquid.
Gravity can then amplify long disturbances while surface tension damps short ones.
The pressure uses the full curvature of the height surface. Downslope gravity and pressure use
the same face mobility on a prewetted panel, so a hanging drop can lose water to its wake as it moves.
For a spanwise-uniform strip, either `cells` dimension can be one. A direct banded
pressure solve also supports strips with advancing and receding contact angles.
On a two-dimensional patch, a line preconditioner helps solve pressure between
a thick bead and its thin precursor while retaining cross-plane capillary flow.
At especially high stiffness the solve corrects pressure in cell space and checks the
resulting face flux against the original pressure equation.

Pass a `Precipitation` field for rain arriving at the moving panel and a `Wind` for surface shear.
A registered rain input can instead publish m/s as a scalar or per cell. The optional `impacts` input
publishes layout-1 f64 rows of U, V, radius, deposited m³ and inward impact speed. A tick is consumed
once, even when a slower writer's last value is held. Pass `waveSources: true` and give `film.waveField`
to the local `WakeSolver` for pressure pulses on a wet platform in the same cell. The film retains
the deposited water and the wake receives the normal impulse.

Use `surfaceGeometry()` to draw the liquid with `createMesh` from `@margoengine/materials`.
It copies positions, normals, UVs and indices in the patch's local metres. Parent a mounted
surface to the same body as the film, update it with `mesh.setGeometry`, and hide it when
the index buffer is empty. Use `depths()` for a thickness texture, `filmField` for
substrate, depth and drip records, and `dripsField` for discharge in m³/s.

For a wet circular sill outlet, open its edge and pass its physical rim radius. The outlet holds
its share of the discharge until a drop detaches.

```ts
import { Physics } from '@margoengine/physics';
import { PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';
import { ThinFilmDropFlight, ThinFilmSolver } from '@margoengine/physics/thin-film';

await Physics.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
const physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 60 });
const mount = physics.addBody(null, {
  gravityScale: 0,
  linearVelocity: [0, 0.002, 0],
  angularVelocity: [0, 0, 0.016],
  colliders: { shape: 'box', halfExtents: [0.08, 0.01, 0.08], mass: 1 },
});
const spacing = 0.03;
const film = await ThinFilmSolver.load({ drops: true });
const flight = new ThinFilmDropFlight(film.dropsField, 'tray-flight', { rigid: true });
const tray = await ThinFilmSolver.load({ id: 'tray', rigid: true, impactRecoil: true, impacts: flight.impactField });
world.add(new RigidSolver(), { physics });
world.add(film, {
  cells: [1, 1],
  spacing,
  origin: [0, 0.07, 0],
  v: [0, -1, 0],
  rainRate: (1e-6 / 60) / (spacing * spacing),
  drains: [false, false, false, true],
  outlets: [{ edge: 'v1', index: 0, radius: 0.0016 }],
}).add(flight, {
  receiver: { bodyRow: mount.row, origin: [-0.04, 0.0002, 0.05], size: [0.12, 0.12], followRotation: true },
}).add(tray, { bodyRow: mount.row, origin: [-0.04, 0, 0.05], cells: [6, 6], spacing: 0.02, depth: 0.0002 });
world.couple(['rigid', 'tray-flight', 'tray'], 'staggered');
world.advance(420);
if (tray.budget.impacts <= 0) throw new Error('Expected the moving tray to catch a sill drop.');
console.log(tray.budget.impacts, mount.linearVelocity[1]);
```

`dropsField` publishes one timed record per rim in its origin cell. Read its end-of-tick XYZ, the rim's XYZ
velocity, volume per drop, first offset from the tick start, interval between drops, and count.
A zero count means the rim released no water that tick. `dripsField` carries the uncaptured
edge discharge, while `budget.dripped` counts all water leaving the backing.

`ThinFilmDropFlight` starts each drop at its release offset and advances it through gravity,
buoyancy and air drag. Provide a `Wind` field for moving air. The particle field exposes live
positions, velocities, sizes, ages and stable IDs. `budget` accounts for the received,
airborne and departed volumes. By default each drop can stay in the flight domain for 10 seconds.
For an absorbing tray, set `receiver` to its free-surface plane and extent. Match its UV axes
and give the tray `flight.impactField` to receive the captured volume and normal speed.
`depositedVolume` is the captured share of flight outflow. For a translating mount, set the
flight's `rigid` connection and the receiver's `bodyRow`. Give the plane in that body's local
coordinates and hold its orientation fixed. Add the rigid solver first, then order the rigid,
flight and receiving film in the staggered group when receiving recoil. The flight sweeps the
tray between consecutive poses and reports normal speed relative to the moving surface.
Set `followRotation: true` to sweep the mount's orientation too. The impact field then publishes
layout-2 f64 rows. After the five ordinary impact words come the contact normal XYZ and the
world-space contact lever arm XYZ from the rigid centre. The receiving film uses those values
to apply normal recoil and its moment at the instant of contact. Keep the flight and receiving
film in the same origin cell for their patch-local records.
Set `captureEdges: true` on a swept receiver to catch a sphere that reaches a wet edge
or corner while its centre stays outside the UV rectangle. Deposition uses the nearest
wet point, and recoil follows the radial contact normal. The default sweeps the face.
An absorbing film mounted on a rigid body can use `impactRecoil: true` to send each impulse and
its torque to the mount. This is off by default. Use either the mount or a wake as the impact
momentum receiver.

To transfer the film's normal weight and moment to a mounted body, enable `hydrostaticLoad`
and add the rigid solver before the film. Couple the two solvers with the staggered scheme.

```ts
import { Physics } from '@margoengine/physics';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';
import { ThinFilmSolver } from '@margoengine/physics/thin-film';

await Physics.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 60 });
const tray = physics.addBody(null, {
  gravityScale: 0,
  colliders: { shape: 'box', halfExtents: [0.25, 0.01, 0.25], mass: 4 },
});
const film = await ThinFilmSolver.load({ rigid: true, hydrostaticLoad: true });
world.add(new RigidSolver(), { physics });
world.add(film, { bodyRow: tray.row, cells: [4, 4], spacing: 0.1, origin: [-0.2, 0, 0.2], depth: 0.0002 });
world.couple(['rigid', 'thin-film'], 'staggered');
world.advance(4);
console.log(tray.linearVelocity[1]);
```

The moving-window fixture draws `film.surfaceGeometry()` with a thickness map from
`film.depths()` and draws `flight.readDrops()` at their simulated size and position.
For an interior view, register the outside water first and give the nearer glazing
a later `Transmission` pass so its scene copy includes the water. With the packages
built, run `npm run test:browser:thin-film -w @margoengine/physics` to capture both
views on both renderer paths and check frame replay.

## Windborne dust, mist and sea spray

`@margoengine/physics/airborne` moves individual environmental parcels using local wind, diameter-dependent
drag, gravity and evaporation. `readParticles()` returns positions in `particles.cell`, diameters in metres,
represented mass in kilograms and current `materialDensity` in kg/m³. Sea-spray density follows the parcel's
water loss and retained salt. The mass ledger, poses and published work describe the last accepted state.

```ts
import { AirborneParticles } from '@margoengine/physics/airborne';
import { PhysicsWorld } from '@margoengine/physics/world';

using particles = await AirborneParticles.load();
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
console.log(particles.readParticles(), particles.budget, particles.workCounts());
```

Enable `terrain` and match the actual `TerrainBed` grid for world-space deposition. Pass
`dustField: aeolian.dustField` to receive mineral dust emitted by EARTH-07. Enable `whitecaps` with the
matching SEA-13 grid in `spray` to turn active whitecaps into three representative diameter bands.
Supply `sources` for existing waterfall mist or mineral footstep dust. If `emissions` is enabled, an
optional source owns one layout-1 f64 kg/s value for each row. Closed mass accounting includes the
discrete parcels, waiting source mass, vapour, settled mass and open outflow.

Use `AirborneParticles.load({ threads: 4 })` with `worldMemory(true)` to integrate four partitions.
For browser threading, start the world in an isolated Worker. The default is one partition on either memory
type. `workCounts()` gives the last accepted tick's native parcel, SIMD axis-pair and evaporation work. Wind
sampling, ordered emissions and mass accounting run on the caller. Dispose the solver when finished.

## Acoustic pressure in rooms and tunnels

Use `@margoengine/physics/room-sound` for low-frequency pressure over an indoor air grid. Solid cells shape the room
and the air-cell reflection values set its wall impedance. Blocks from `readTrace()` contain ordered pressure samples
and their sample rate. Concatenate consecutive blocks to measure a room response with `roomEnergyDecay()`.
The grid spacing and speed of sound determine the dyadic substeps inside each world tick. With no
excitation field the first pressure increment defaults to 1 Pa. With that field it defaults to 0 Pa.

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
step or one increment for each internal sample in a layout-1 f64 port in the room's cell. `pressureLayout`
gives the native region's voxel strides. The solver publishes the receiver and pressure in its current signed
cell. An invalid input or unrepresentable pressure update leaves the previous trace and both pressure buffers
available. Browser or Node callers can cancel the optional asset load with an AbortSignal.

`RoomSoundSolver.load({ threads: 2 })` and `load({ threads: 4 })` use shared world memory and actual helper
workers in Node or a cross-origin-isolated browser worker. The count includes the caller. The default one
participant runs in both memory modes and in a browser window. `workCounts()` reports the last accepted
step computed by this instance, with samples and actual f64x2 stencil pairs per participant. Call
`dispose()` after the world's final step to release its helpers.

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
const draw = mud.particleSource();
console.log(mud.budget.storedReferenceVolume, mud.sample(0).position, draw.count);
```

Pass the geometry of a registered `TerrainBed` to `load({ terrain })` to collide with the live bed.
For an inlet, pass a field descriptor to `load({ inlet })` and reserve `capacity` for the material
points. The layout-1 f64 inlet rows are position XYZ, velocity XYZ and m³/s. An open face lets
material leave and frees its point row for the next inlet sample. The reference volume is mass
divided by rest density. The current volume also includes elastic compression.

`pointField` publishes `VISCOPLASTIC_WORDS` layout-1 f64 values per allocated point, including
position, velocity, current volume, pressure, shear stress, plastic shear and presence. Draw only
the present points. `solventViscosity` adds implicit Newtonian diffusion to the material's plastic flow.

Pass `mud.particleSource()` as `particles` to `ParticleLiquid.attach` from
`@margoengine/water/liquid`. After advancing or restoring the world, call the effect's
`update(mud.particleSource())` to draw that accepted tick. The source compacts active points as
XYZ and velocity in interleaved f32 storage with six floats per point. Pass an optional reusable
array with its own ArrayBuffer and a renderer world cell as the first and second arguments. The default uses the solver's
current cell. Use a nearby renderer cell so float32 still resolves individual grid cells.

Load with `threads: 2` to `threads: 64` to partition the native occupied-node and material-point
updates. Pass `worldMemory(true)` to PhysicsWorld. Run shared workers in Node or a cross-origin-
isolated browser worker. In a browser window, the default `threads: 1` serves the render loop
directly. `workCounts()` reports the last successful tick's actual transfer and occupied-node
rows. Native steps recompute the receipt on replay. Dispose the solver with `using` or
`[Symbol.dispose]()` after removing it from the world.

The explicit solver declines ticks that require more than 4,096 microsteps. Increase spacing or
reduce stiffness or speed in that case. A rejected update leaves the accepted points and ledgers
available for a corrected replay.

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
const sea = pulse.surfaceSource();
console.log(sea.sample(9.125, 0.125, { depth: 0, surface: 0, velocity: [0, 0] }));
```

For a coastal scene, pass `pulse.surfaceSource()` as `source` to Water's `ShallowWaterSurface.attach`.
Give Water terrain with the same cell dimensions, extent, placement and elevation datum as the solver.
Advance the physics world before drawing. The mirror reads the accepted depth and discharge and hides
dry cells until the wave inundates them. Its reusable sample gives distance in local metres and surface
altitude above the same datum as the terrain. Floating-origin placement stays with the scene that owns both.

Use `incoming` to launch a long wave through an open edge. In low/high X, low/high Z order, pass a
callback for each driven side. The callback receives the world tick midpoint and supplies an exterior
surface altitude and outward-normal speed. A negative speed enters the grid. Omit callbacks for still
exterior water. The budget's signed `boundaryExportVolume` subtracts incoming water and adds outgoing water.

```ts
import { sin } from '@margoengine/math/pinned';
import { PhysicsWorld } from '@margoengine/physics/world';
import { TsunamiSolver } from '@margoengine/physics/tsunami';

const pulse = await TsunamiSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(pulse, {
  cells: [64, 4],
  spacing: 0.5,
  bathymetry: -2,
  open: [true, false, false, false],
  incoming: [(time) => {
    const phase = sin(Math.PI * time / 20);
    const surface = 0.025 * phase;
    return { surface, outwardVelocity: 2 * (Math.sqrt(9.80665 * 2) - Math.sqrt(9.80665 * (2 + surface))) };
  }],
  laminarBed: { kinematicViscosity: 1e-6, period: 40 },
});
world.advance(60);
console.log(pulse.budget.boundaryExportVolume);
```

On a smooth bed with laminar flow, give `laminarBed` the water's kinematic viscosity in m²/s and the
incident wave period in seconds. It applies the dissipative part of the depth-dependent oscillatory
bed stress. Omit it for the default frictionless bed, or use positive `manning` for the existing roughness
model. Positive Manning and laminar attenuation are mutually exclusive. To restore or replay a world,
use the same registered solver configuration, including its period and viscosity.

One thread is the default. In Node or a cross-origin-isolated browser worker, pass
`threads` to split the two-dimensional flux sweeps across a shared-memory world.
The count is a whole number from one to 64 and includes the caller. The browser window uses
the default single-thread path. Choose a count that fits the patch dimensions and available
cores. The count may change between runs without changing the physical snapshot or hash.
Remove the solver from the world before disposing it to release the workers.

```ts
import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';
import { TsunamiSolver } from '@margoengine/physics/tsunami';

using pulse = await TsunamiSolver.load({ threads: 4 });
const world = new PhysicsWorld({ memory: worldMemory(true) }).add(pulse, {
  cells: [21, 13],
  spacing: 0.5,
  bathymetry: -1,
});
world.advance(1);
console.log(pulse.workCounts());
world.remove('tsunami');
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

```ts
import { AccretionDiskSolver, KerrGeodesicSolver, kerrCircularOrbit } from '@margoengine/physics/accretion';
import { PhysicsWorld } from '@margoengine/physics/world';

const centralMass = 2e35;
using disk = await AccretionDiskSolver.load();
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
Shorten the step or increase the world rate if it would require more than 16,384 subdivisions.

The disk publishes density, heating and orbital phase in increasing radial order with the solver's signed cell.
The values use absolute radial units. A world-origin shift leaves disk radii and exterior coordinates unchanged.
An external feed may come from the world or the aligned f64 region in the memory named by its port. Invalid supply
or a rejected trial leaves all published fields and the accepted budget unchanged.

`load({ threads: 1 })` defaults to one native participant. Use two or four with shared world memory in Node or
an isolated browser worker. The disk keeps viscous transport and its budget reductions in radial order and
splits the independent density, phase and heating publication into SIMD-aligned ranges. `readNativeWork()`
reports the accepted annuli and paired rows. Stop advancing the world before disposing the disk.

## Synoptic weather, fronts and mountain precipitation

`SynopticWeather` evolves regional vorticity, column vapour, cloud water, falling condensate and temperature in a
fixed map frame. It publishes wind, pressure, altitude-adjusted air temperature, precipitation and integrated vapour
transport. The atmosphere and its water budget share the PhysicsWorld clock.

```ts
import { SynopticWeather } from '@margoengine/physics/synoptic';
import { PhysicsWorld } from '@margoengine/physics/world';

using weather = await SynopticWeather.load();
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
The advected temperature and terrain elevation set the saturation capacity of each column. Ascent cools the column.
Vapour condenses once the cooling uses up the saturation deficit. Descending air can evaporate cloud water up to its
available capacity. Supply `liftSensitivity` in kg/m³ to override the default local moist-adiabatic response.
Set `timeScale` for a time lapse. Rates and the water ledger refer to physical weather seconds.

Set `layers: { upperMeanWind: [30, 0] }` in the high tier to evolve a sheared atmosphere. `sampleLayers()` reads
both streamfunctions and winds and the temperature anomaly from pressure-level thickness. The default 200 km
deformation radius sets the separation of barotropic and baroclinic modes. Wind interpolates between 1500 and 5500 m
by default. The weather and water readers use the winds from the same physical frame.

`wind` is the existing `Wind` contract for a cloud box or other atmospheric reader. `rainSource()` supplies surface
mm/h to `PrecipitationField`. Set its `base` just above the ground when the upstream physics has already accounted for
fallout. Load with `{water: true}` and pass the grid of a `ShallowWaterSolver` to accumulate pressure gradients and wind
stress on it. Arrange the pair in a staggered coupling, and give the water the weather's `timeScale` (the world refuses
the pair at two scales). `@margoengine/weather/synoptic` adapts the same solve for Sky. Registered fields carry
the solver's signed cell. The water field can live in its own memory. The atmosphere and its water contribution
are accepted together, so a bad water input preserves the previous atmosphere, forcing and budgets.

The optional native publication uses one participant by default. Pass `threads: 2` or `threads: 4` to
`load()` with shared world memory in Node or an isolated browser worker. Independent cells publish paired
temperatures and IVT products with SIMD. `readNativeWork()` reports accepted cells and work per participant.
Stop advancing the world before disposing the solver.

## Explosive sources (`@margoengine/physics/explosive`)

The energy a high-explosive charge releases and where it goes (FIRE-05). `chargeEnergy(mass, explosive)` is the mass
times the heat of detonation, and `tntEquivalent(energy)` its TNT equivalent at 4.184 MJ/kg. `EXPLOSIVES` holds the
measured Gurney velocities and heats of detonation of Kennedy (1970), Table 2. `gurneyVelocity` uses the measured value,
or 0.7 of the heat of detonation where none was measured (Kennedy eq 16). `metalSpeed(gurney, geometry, M/C, N/C)` is
the speed a case or plate reaches by Gurney's equations: `cylinder`, `sphere`, `flatSandwich`, `openFacedSandwich` and
`asymmetricSandwich` with a tamper. They hold for M/C from 0.2 to 10, and a ratio outside that is refused.

A buried charge keeps most of its energy in the ground. `scaledDepth(depth, energy)` is depth / E^(1/3) in m J^-1/3.
`airborneFraction(scaledDepth)` is the share that leaves as an air blast (Ford et al. 2014): 0.90 at the surface,
under 1 % at the 4e-3 m J^-1/3 that digs the largest crater. That share is a hemispherical blast over the ground.
`freeAirEquivalent(budget)` is twice it, the free-air blast it spreads as (its image in the ground), and is what
free-air blast laws take. `energyBudget(energy, depth, ground)` splits the energy into `air` (what the blast solver
reads) and `ground`, and splits the ground's share three ways:

- `groundShock`: what radiates as seismic waves, `seismicCoupling` of the ground share. The default is
  `SEISMIC_COUPLING.dryAlluvium` (0.05 %); `SEISMIC_COUPLING.competentRock` is 1 % (Rodean 1970).
- `craterWork`: the least work that empties the crater, which is lifting the bowl and throwing it past the rim. The crater
  is a paraboloid of `craterRadius` (a survey's or the cratering solver's) and `depthRatio` (default 0.24, Fauld's) in
  host of `density` (default 1800 kg/m^3). Without a radius, Sonder et al.'s crater law `scaledCraterRadius` gives one;
  at Fauld it gives the measured 250 m.
- `heat`: the rest, which is the cavity's hot gas, crushing and friction.

```ts
import { energyBudget } from '@margoengine/physics/explosive';

// Fauld: the bomb store about 35 m down in gypsum and mudstone (Waltham 2001).
const split = energyBudget(1.013e13, 35, { density: 2300 });
console.log(split.air, split.groundShock, split.craterWork, split.heat);
```

```ts
import { energyBudget, EXPLOSIVES, gurneyVelocity, metalSpeed } from '@margoengine/physics/explosive';

// Fauld, 27 November 1944: 5.34 million lb of TNT equivalent (Fielder and Guest 1967), about 35 m down (Waltham 2001).
const fauld = energyBudget(5.34e6 * 0.45359237 * 4.184e6, 35, { density: 2300 });
console.log(fauld.tntEquivalent.toFixed(0), (2 * fauld.craterRadius).toFixed(0), 'm crater', fauld.craterMass.toExponential(2), 'kg');
// A TNT-filled steel cylinder with twice its charge's mass of case.
console.log(metalSpeed(gurneyVelocity(EXPLOSIVES.tnt), 'cylinder', 2).toFixed(0), 'm/s');
```

`ExplosionSolver` puts charges into a `PhysicsWorld` as placed events. Each detonates at its `time`. Its row of the
`explosionsField` (`EXPLOSION_WORDS` f64 words: position, time, energy, air and ground energy, scaled depth, gas mass,
detonated, then ground shock, crater work, heat and crater radius) is what the blast, crater, seismic and plume solvers
read. `soil` gives the charges' ground (`GroundOptions`). A charge at depth 0 whose centre is higher above `groundHeight`
than its own radius is in the air: all of its energy is blast. A cased charge at or above the surface throws its `case`
as fragments (`fragmentsField`, `FRAGMENT_WORDS` words: position, velocity, mass, state). They launch at Gurney's speed for
the case to charge mass ratio, with masses drawn from Mott's distribution (N(>m) = N0 exp(-sqrt(m/mu))) and scaled to the
case mass. They leave in opposite pairs of equal mass, so the launch adds no momentum. They fly under the world's gravity
and quadratic air drag (`dragCoefficient`, default 1, on a sphere of the fragment's mass and `density`) until they reach
`groundHeight`, or on the terrain bed. A charge's `film` is art direction, not physics: `aim` and `spread` (default
pi / 6) send its case fragments into a cone, and `speedScale` (default 1) scales their launch speed. The masses stay
Mott's, but aimed fragments leave one by one rather than in opposite pairs, so the launch carries momentum. With `dust`
(made with `new ExplosionSolver(id, { dust: airborne.emissionField })`), each linked charge emits `fraction` of its
crater mass into an `AirborneParticles` source (ATMO-06) at a constant rate over `duration`, by default the flight time
of a throw past the rim at 45 degrees, sqrt(2 R / g). `seed` breaks
the same cases another way; `counts` gives the fragments in flight,
the fragment steps taken and the guns' integration steps. A buried charge (`depth` above 0) keeps its case in the ground.

`await ExplosionSolver.load(options)` flies the fragments in the explosive kernel, a Rust crate compiled to Wasm with SIMD.
It gives the same bits as the TypeScript path (`new ExplosionSolver(id, options)`, and `flyFragments`, its twin), with the
same work counts. `ExplosionSolver.load({ threads })` flies them on that many threads, 1 to 64, over a shared world
memory (`worldMemory(true)`). Each worker has its own instance of the kernel and flies a fixed partition of the fragments;
the main thread flies the last. Any thread count gives the same bits, and `counts.threadSteps` shows each thread's
fragment steps. `endThreads()`, or `using`, stops the workers. `terrain` (a `BedShape`) lands the fragments on the world's `bed` field, which a `TerrainBed` of that
shape publishes, at the elevation `BedSurface.sample` gives.

```ts
import { TerrainBed } from '@margoengine/physics/earth';
import { ExplosionSolver } from '@margoengine/physics/explosive';
import { PhysicsWorld } from '@margoengine/physics/world';

const shape = { columns: 32, rows: 32, width: 400, depth: 400, centre: [0, 0] as [number, number] };
const blast = await ExplosionSolver.load({ terrain: shape });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] })
  .add(new TerrainBed(), { ...shape, elevations: (x: number) => 0.2 * x })
  .add(blast, { charges: [{ position: [0, 30, 0], mass: 20, case: { mass: 40, fragments: 400, geometry: 'sphere' } }] });
world.advance(600);
console.log(blast.kernel, blast.counts);
```

Hits. Pass `physics`, the Physics the `RigidSolver` steps, and each fragment's and shot's path is cast against the rigid
world every step. The first body met stops the fragment at the hit point, as state 3. With `carriers`, the body takes the
fragment's momentum through `bodyImpulses` at that point. Each hit is a row of `hitsField` (`HIT_WORDS`: point, velocity
as it struck, mass, body row, time, 1 once hit) and of `hitRows()`. `breakables`, a `BreakableWorld` or anything with
`applyImpact(point, impulse)`, takes each hit as an impact (BREAK-01).

`plates` (with `new ExplosionSolver(id, { carriers: true, hullPlates: true })`) are hull plates the hits load. Their
`damageField` is in the crush damage layout, so `new HullSolver(id, undefined, blast.damageField)` opens a hull opening
whose `crushPatch` is the plate's index once the plate is holed (SEA-10). A hit's seal loss is its kinetic energy into the
plate over the shear work of punching a plug of the striker's diameter through the plate, pi d h^2 tau / 2
(`shearStrength` tau, default 145 MPa for mild steel).

```ts
import { ExplosionSolver } from '@margoengine/physics/explosive';
import { Physics } from '@margoengine/physics';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';

await Physics.load();
const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
const wall = physics.addBody(null, { position: [5, 0, 0], colliders: { shape: 'box', halfExtents: [1, 1, 1], mass: 100 } });
const blast = new ExplosionSolver('blast', { carriers: true });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, 0, 0] })
  .add(new RigidSolver(), { physics })
  .add(blast, { physics, charges: [{ position: [0, 0, 0], mass: 1, case: { mass: 2, fragments: 200 } }] })
  .couple(['blast', 'rigid'], 'staggered');
world.advance(30);
console.log(blast.counts.hits, wall.linearVelocity);
```

```ts
import { ExplosionSolver } from '@margoengine/physics/explosive';
import { PhysicsWorld } from '@margoengine/physics/world';

const solver = new ExplosionSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] }).add(solver, {
  charges: [
    { position: [0, 1, 0], time: 0.1, mass: 10, case: { mass: 20, fragments: 64 } },
    { position: [40, -4, 0], time: 0.5, mass: 1000, depth: 4 },
  ],
});
world.advance(60);
console.log(solver.charge(1).air / solver.charge(1).energy, solver.counts.flying);
```

Guns (interior ballistics). `fireGun(options)` fires a gun's charge with a lumped model: Resal's energy equation, Lagrange's
pressure gradient and Corner's burning law. The propellant burns at `burnRate` × p^`pressureIndex` through its `web`, with
a grain `form` (1 a cord, 0 a tube). Its gas follows the Noble-Abel law (`force`, `covolume`, `gamma`). The shot is driven
down the bore while the gun recoils, and momentum is conserved exactly among the shot, the gun and the gas. After the shot
leaves, the bore blows down through the muzzle as a choked nozzle; that is the recoil's after-effect. The result
(`Firing`) gives:

- the muzzle and ground velocities and the muzzle time;
- the peak mean, breech and base pressures;
- the recoil momentum at the muzzle and after the blowdown;
- the muzzle gas's energy and mass;
- a `history` of time, travel, speed, pressure and recoil momentum.

`PROPELLANTS` holds cordite and pebble powder, with Noble-Abel constants fitted to Noble and Abel's closed-vessel
pressures. `closedVesselPressure(propellant, loading)` gives that pressure. Cordite's burning rate is calibrated to the
1911 Britannica's 6-in. gun at 2150 ft/s.

In `ExplosionSolver`, `guns` places guns in the world. Each fires at its `time` from its `breech` along its `axis`. On a
rigid `body`, which needs `new ExplosionSolver(id, { carriers: true })` and a `RigidSolver`, the body's mass is the
recoiling mass, its pose aims the gun, and the recoil goes into the body through `bodyImpulses` at the breech. The shot
flies as a fragment with `shotDrag` on the bore's area. `muzzleBlast(i)` is the gun's row in the explosions field: the
muzzle gas's energy, all of it into the air, at the time the shot leaves.

```ts
import { ExplosionSolver, fireGun } from '@margoengine/physics/explosive';
import { Physics } from '@margoengine/physics';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';

const IN = 0.0254, LB = 0.45359237;
const sixInch = { bore: 6 * IN, travel: 5.48, chamber: 730 * IN ** 3, shotMass: 100 * LB, charge: 13.25 * LB, web: 0.15 * IN };
const fired = fireGun(sixInch);
console.log(fired.muzzleVelocity.toFixed(0), 'm/s', (fired.peakPressure / 1e6).toFixed(0), 'MPa');

await Physics.load();
const physics = new Physics(null, { gravity: [0, -9.81, 0], fixedTimestep: 1 / 60 });
const carriage = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [2, 1, 1], mass: 7000 } });
const battery = new ExplosionSolver('battery', { carriers: true });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] })
  .add(new RigidSolver(), { physics })
  .add(battery, { guns: [{ ...sixInch, time: 0.1, body: carriage.row, breech: [0, 0.5, 0], axis: [1, 0.05, 0] }] })
  .couple(['battery', 'rigid'], 'staggered');
world.advance(30);
console.log(carriage.linearVelocity, battery.gun(0).recoilMomentum, battery.muzzleBlast(0).energy);
```

### Blast loading (FIRE-04)

`blastAt(energy, distance, air)` is the free-air blast of `energy` joules at `distance` metres. It follows Kinney and
Graham's (1985) laws, scaled by Sachs's factors to the air's `pressure` (default 101,325 Pa) and `temperature` (default
288.15 K). It returns:

- `overpressure` (peak side-on, Pa), `impulse` (positive phase, Pa s) and `duration` (s);
- `arrival`, from the Rankine-Hugoniot shock speed;
- `decay`, the modified Friedlander wave that carries that impulse;
- `reflected`, the normally reflected peak.

`overpressureAt(point, t)` and `impulseSoFar(point, t, reflected)` give the wave `t` seconds after it arrives.
A charge at or under the ground blasts as a free-air charge of `freeAirEquivalent(budget)` (twice its air energy), and
that matches Ford et al.'s field-measured surface-burst impulse to 12 %.

`BlastSolver` reads an `ExplosionSolver`'s explosions field and loads the rigid bodies the blast reaches; add the
explosive solver first. Each body takes, along the line from the charge, its box's area seen from the charge times the
reflected impulse that has arrived. What it has already been given is subtracted, so a body that moves during the
positive phase gets the whole impulse once. `threshold` (default 200 Pa) is the overpressure below which nothing is
applied. `breakables` takes each load as an impact (BREAK-01). `pressureAt(point, time)` sums every charge's overpressure
at a point, for sound and camera shake.

```ts
import { BlastSolver, ExplosionSolver } from '@margoengine/physics/explosive';
import { Physics } from '@margoengine/physics';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';

await Physics.load();
const physics = new Physics(null, { gravity: [0, -9.81, 0], fixedTimestep: 1 / 60 });
const shed = physics.addBody(null, { position: [20, 1, 0], colliders: { shape: 'box', halfExtents: [0.5, 1, 1], mass: 100 } });
const charges = new ExplosionSolver('charges');
const blast = new BlastSolver(charges.explosionsField);
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] })
  .add(new RigidSolver(), { physics })
  .add(charges, { charges: [{ position: [0, 0, 0], time: 0.05, mass: 1 }] })
  .add(blast, { physics })
  .couple(['blast', 'rigid'], 'staggered');
world.advance(30);
console.log(shed.linearVelocity, blast.counts, blast.pressureAt([0, 1.5, 30], 0.15));
```

## Craters (`@margoengine/physics/crater`)

The crater a buried charge digs, its rim and its ejecta blanket, on the terrain bed (EARTH-06). `craterSize(energy, depth, ground, gravity)` is the apparent crater of a charge of `energy` J with its centre `depth` m down:

- Its scale is Holsapple and Housen's point-source scaling for explosions. It runs from cube-root scaling for small charges, held by the ground's strength, to gravity scaling for large ones.
- How burial changes the radius and depth is fitted to the Nevada desert-alluvium HE shots.
- Too deep, past 1.6 m per cube root of a TNT kilogram, a charge leaves a mound and no crater.
- `CRATER_GROUNDS` holds Holsapple and Housen's explosion constants for dry sand, dry soil (the default, desert alluvium), wet soil, soft rock, hard rock and ice, with measured bulking.

Checked against craters it was not fitted to, the radius is within 26 percent, the scatter of identical shots:

- the nuclear shots in alluvium, among them Sedan;
- basalt and tuff, among them Danny Boy and Schooner;
- Fauld's bomb store in mudstone.

`CraterSolver` digs them in a `TerrainBed`. It reads the `ExplosionSolver`'s explosions (each one's energy and depth, from its `explosions` field), and a charge that goes off in the ground digs:

- a paraboloid bowl over the crater's formation time;
- a rim lifted from the share of the crater neither thrown nor compacted;
- an ejecta curtain of equal-mass shells, launched at 45 degrees and landing as a blanket that thins as r^-3. Half of it lands within two crater radii, as at Sedan.

The bed's volume balances to rounding. `ledgerTotals()` gives the volume dug, lifted, compacted, thrown, landed and carried past the bed's edge. `crater(i)` gives each crater's size, how far it has formed and its ejecta curtain's extent. The `crater:craters` field publishes the same for renderers and the base surge. `size` and `pace` scale a crater and its formation time for film.

```ts
import { CRATER_GROUNDS, craterSize } from '@margoengine/physics/crater';

// Scooter (1960): a million pounds of TNT 38 m down in Nevada alluvium dug a crater 47 m in radius.
const crater = craterSize(453600 * 4.184e6, 38.1, CRATER_GROUNDS.drySoil, 9.81);
console.log(Math.round(crater.radius)); // 48
```

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
  links: sources.map(({ position }) => ({ source: position, listener: [2000, 2, 480] as [number, number, number] })),
});
acoustics.advance(1);
const arrivals = sources.map(({ emissionTime }, index) => emissionTime + sound.read(index).delaySeconds);
console.log(lightning.flash, lightning.channel().trunk, Math.min(...arrivals));
```

The default grid is `13 × 19 × 13` with 80 m spacing above the origin and an upper plane at −100 MV. The cloud seed
starts at the centre of the top plane at world time zero. The default leader and return speeds are 200,000 and
100,000,000 m/s. The default growth weight is the square of the normalized voltage difference.
With `breakdown`, the thresholds reduce the eligible bond drops and the exponent defaults to one.
Pass `exponent` to override either default. `charge` samples a static free charge density in C/m³. The dimension-dependent default sweep count targets a normalized potential
correction of `1e-6`, exposed as `residual`. `brightness(time)` gives the relative return envelope with a 10 µs
rise and a 50 ms fade by default. A `bed` in another cell uses `cell` and `cellSize` (default 4096 m) to align the
samples. Pass the same initial `cell` to `world.add()` if the grid is outside the origin cell.

`channelField` has a header `[segment count, trunk count, ...]` in one `LIGHTNING_CHANNEL_WORDS` f32 row, followed by
the trunk polyline and branches. `thunderField` has one `LIGHTNING_THUNDER_WORDS` f64 header row with the source count,
followed by source XYZ (m), emission time (s), relative weight and segment length (m). Apply source emission time
before acoustic flight time. `channel()` and `thunder()` return copies of their active data.

Set `breakdown: { initiation, propagation }` to gate the first link and subsequent links with electric
fields in V/m. Both values are positive. A field below the relevant threshold can leave the flash
`halted` without ground contact or thunder. Omit `breakdown` for the unthresholded seeded mode.
The solver's `status` distinguishes a pending or growing leader, a halt and a grounded flash.

Pass `field: () => lightning.boltSource(world.time, renderCell)` to Sky's `LightningBolt.attach`.
Advance the world before drawing. The callback reads the accepted channel region directly, and
`renderCell` translates it into the camera's origin cell. Omit the cell when the renderer uses the
solver's origin cell. A third argument sets leader brightness relative to the return stroke; it
defaults to 0.1. This is an appearance control. See the Sky README for a complete example.

One CPU thread is the default. Pass an integer `threads` from 1 to 64 at load time. With more than
one, use a shared-memory world in Node or a cross-origin-isolated browser worker. The solver splits
native stencil rows, retaining exactly the serial channel and electric field. Remove it from its
world before disposal to release the workers. `workCounts()` reports the most recent accepted
electrical update, including the initial solve. It is execution telemetry, outside the snapshot.

```ts
import { LightningSolver } from '@margoengine/physics/lightning';
import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';

using lightning = await LightningSolver.load({ threads: 4 });
const world = new PhysicsWorld({ memory: worldMemory(true) }).add(lightning, {
  size: [17, 19, 13],
  charge: (x, y) => y > 500 ? 1e-11 : x > 480 ? -1e-11 : 0,
});
console.log(lightning.workCounts());
world.remove('lightning');
```

## Natural lava flow and coastal displacement

`@margoengine/physics/lava` advances a vent-fed lava sheet on the PhysicsWorld clock. It transports mass and enthalpy, grows stationary crust, follows slopes and channels, and stops sub-yield flow. It can sample a live `TerrainBed` and publish the volume entering the sea to `TsunamiSolver`.

<!-- example: natural-lava-flow -->
```js
import assert from 'node:assert/strict';
import { LavaSolver } from '@margoengine/physics/lava';
import { TsunamiSolver } from '@margoengine/physics/tsunami';
import { PhysicsWorld } from '@margoengine/physics/world';

const cells: [number, number] = [16, 2];
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

The default `transport: 'inertial'` evolves discharge with the shallow-layer momentum equations.
Choose `transport: 'terminal'` for a creeping wide sheet, where the pressure-head slope sets a
terminal Bingham discharge. Omit initial discharge in this mode. Zero `conductivity` removes internal
and basal conduction and uses the well-mixed bulk as the exposed surface. Set `emissivity`,
`convection` and `waterHeatTransfer` to zero for a thermally isolated sheet.

Load with `threads: 2` to `threads: 64` to split the native grid work, and give `PhysicsWorld` a
`worldMemory(true)` arena. Run the shared solver in Node or a cross-origin-isolated browser worker.
The rendering window can run the default `threads: 1`. Use `using` on the solver or call its
`[Symbol.dispose]()` after removing it from the world. `workCounts()` reports the last successful
runtime tick's cell visits and face fluxes per worker. Seeking recomputes the counts as ticks run.

In a rendered scene, attach `LavaSurface` from `@margoengine/weather/lava` with
`source: () => lava.surfaceSource(renderCell)`. Advance the physics world before the frame.
Omit `renderCell` when the stage uses the solver's origin cell. The renderer uses the accepted depth,
skin Kelvin, crust thickness and altitude from the same published grid.

### Position-based water for interactive pours and splashes

`@margoengine/physics/pbf` advances a free-surface liquid on the physics clock. Its sparse native neighbour search
works in local cell coordinates. Choose `fast` for four density projections per advective substep or `precise`
for twelve. Both profiles solve positive pressure at open interfaces. The optional `cohesive` setting restores
the signed constraint for stylized sheets and droplets. `tensile` sets the artificial pressure at 60 Hz.
Its positional displacement scales with the square of each substep. Free-water pairs with both density
constraints inactive remain at rest.

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

The `viscosity` option blends neighbouring particle velocities. Each pair uses its own neighbourhood weights, so a
detached cloud has no effect on the blending. Smoothing preserves linear momentum and cannot add kinetic energy.

PBF argument errors retain `TypeError` for invalid shapes with `code: 'PHYSICS_INPUT_TYPE'` and `RangeError`
for values outside the supported range with `code: 'PHYSICS_INPUT_RANGE'`. Each message gives the correction
and links to the physics documentation.

### Divergence-free liquid pressure

`@margoengine/physics/dfsph` solves density and velocity divergence independently on the world clock. The
default `accurate` profile allows up to 40 density and 32 divergence iterations per advective substep.
The `interactive` profile uses 12 for each. Both use the same cubic kernel, implicit kinematic viscosity and
sparse native grid. The statistics report actual pair evaluations and `neighborhoodSearches` separately.
Run it at a higher dyadic `rate` for fast liquid and small features.

```ts
import { DfsphSolver } from '@margoengine/physics/dfsph';
import { PhysicsWorld } from '@margoengine/physics/world';

const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const water = await DfsphSolver.load(world.memory);
const spacing = 0.06;
const particles = Array.from({ length: 64 }, (_, i) => ({
  position: [
    (0.5 + i % 4) * spacing,
    (8.5 + Math.floor(i / 16)) * spacing,
    (0.5 + Math.floor(i / 4) % 4) * spacing,
  ] as const,
}));
world.add(water, { particles, spacing, density: 1000, viscosity: 1e-6, surfaceTension: 0.07274 });
world.advance(24);
console.log(water.mass, water.sample(0).position, water.statistics.compression);
```

The particle field publishes f64 XYZ, velocity XYZ, density and mass. Use `positions(out)` to stage active
XYZ rows for `ParticleLiquid` in `@margoengine/water/liquid`. Reserve `capacity` to append material with `emit`.
The box's closed faces sample the pressure kernel beyond their planes on the rest lattice. Select
`wallKernel: 'analytic'` for the continuous integral. Use `wallPressure: false` for hard
contacts alone, or per-face `walls` settings for open edges. The optional `surfaceTension` applies a
separate liquid–air surface energy in N/m. Use `solidLiquidTension` and `solidVaporTension` in the same units
to select wetting. A larger solid–air value favours wetting and a larger solid–liquid value repels.
The integral of the smoothed cubic-kernel colour across a flat interface fixes its energy per unit area
to the supplied tension. Resolved drop frequencies still carry a finite-resolution error.
The implicit viscosity applies at closed planar walls as well as sampled solid shapes.
By default pressure and viscosity reuse the exact sampled gradient records during a geometry step. Set
`cacheNeighbors: false` if arena memory is tight. The fallback evaluates the same kernel and pair order.

A fixed or rigid-body box, sphere or capsule uses sampled pressure at its moving surface. For live rigid
exchange, load with `rigid: true`, set the boundary's `body` row and use
`world.couple(['rigid', water.id], 'staggered')`. Pass a one-track `ModalSoundSolver.contactField` as
`modalContactField` to excite resonances from hard liquid impacts. Run both at the same world rate.
Each pressure iteration evaluates rigid boundary velocities after their reciprocal linear and angular
impulse. The solver takes inverse mass and world-axis inverse inertia from the rigid body field.
At a direct contact, friction removes the configured fraction of projected tangent slip while preserving
the normal contact constraint and applying the matching wrench to the solid.
Viscous momentum transfer to a moving solid is solved implicitly with the solid's recoil and the
fluid velocity in the same system.

Use `parcelCapacity` when a second world solver owns a liquid volume and momentum ledger. Register
`parcelFields.requests` as its output and `parcelFields.receipts` as its input on the same dyadic rate,
then place both endpoints in a staggered group. Publish exactly `parcelCapacity` layout-1 f64 rows of
`[ticket, particleRow, x, y, z, volume, px, py, pz]`. Assign increasing positive integer tickets.
A positive `particleVolume` and row `-1` emit a particle with the supplied position and momentum.
A negative volume of the same magnitude withdraws the indicated row and returns its actual position and
opposite momentum. Receipts use a zero volume when the requested row or capacity is unavailable.
The other endpoint reserves each transfer and settles it once from the matching receipt. Outgoing transfers
may change other particle row indices. Read the current particle field before requesting another batch.
In the [wet-cell integration test](tests/coupling/dfsph-hydro.test.js), a live shallow-water solver applies
the matching signed volume through its inflow and horizontal momentum through its forcing field on the
same tick. Vertical momentum stays in the receipt ledger. Keep donor and receiver cells wet throughout
that step. The shoreline case needs a receipt for what its wet/dry update accepts.

#### Liquid impact energy

Pass `impacts: true` to publish one layout-1 f64 row on `impactField`.
Its words are `[offsetSeconds, x, y, z, normalImpulse, energy, count]`. Position is local to
the field port's world cell. Its time is the port tick divided by the solver rate plus the offset.
The solver sums hard-contact impulse and dissipated kinetic energy through the tick. The position
and offset are their energy-weighted centres. A zero count identifies an empty tick.

```ts
import { DfsphSolver } from '@margoengine/physics/dfsph';
import { PhysicsWorld, regionWords } from '@margoengine/physics/world';

const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, 0, 0] });
const liquid = await DfsphSolver.load(world.memory, { impacts: true });
world.add(liquid, {
  spacing: 0.5, wallPressure: false,
  bounds: [[-2, 0, -2], [2, 2, 2]],
  particles: [{ position: [0, 0.26, 0], velocity: [0, -1, 0] }],
});
world.advance(1);
const field = liquid.impactField;
const port = field && world.fields.port(field.name);
if (!port) throw new Error('Impact field is unavailable. Enable impacts and advance through contact.');
const [, , , , normalImpulse, energy] = regionWords(world.memory, port.region);
if (normalImpulse !== 125 || energy !== 62.5) throw new Error('Expected the 125 kg sample to strike the floor.');
console.log(energy);
```

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
mechanical waves and contact impulses. The arc pulse is an animation event. On a curve the bogies
and carbody load the same outer side in either travel direction at the same speed.

The default `threads: 1` runs in either world memory mode. Pass `{ threads: 2 }` or `{ threads: 4 }`
to `RailSolver.load` for concurrent catenary work on `worldMemory(true)` in Node or a cross-origin-isolated
browser worker. The count includes the caller. Use one threaded solver per world and dispose it after
the last step. `wireWorkCounts()` describes the last accepted wire step this instance computed,
including its velocity rows, position rows and actual f64x2 visits. The report is outside the snapshot.

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
followed by seven head words each. Both ports publish in the solver's current signed world cell.
World snapshots preserve the commands, spring and axle state, wire motion and arc pulse.
Coded numeric errors leave the previous car and wire state available.

## Soil tracks, footprints and airborne fines

Use `@margoengine/physics/terramechanics` to apply a measured wheel, belt, shoe or hoof load to a live
`TerrainBed`. The solver distributes the displaced material into compaction, berms and dry mineral fines.

```ts
import { TerrainBed } from '@margoengine/physics/earth';
import { Terramechanics } from '@margoengine/physics/terramechanics';
import { PhysicsWorld } from '@margoengine/physics/world';

const terrain = { columns: 24, rows: 24, width: 2.4, depth: 2.4, centre: [0, 0] as const };
const bed = new TerrainBed();
const soil = await Terramechanics.load({ tier: 'resolved' });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
  .add(bed, { ...terrain, elevations: () => 0 })
  .add(soil, {
    terrain,
    patches: [{ x: 0, z: 0, length: 0.25, width: 0.12, load: 500 }],
    hardpan: { thickness: 0.16, frictionalModulus: 900_000 },
  })
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
Set `floor` for uniform bedrock. Use `floorGrid` with one value per bed vertex or the same coordinate sampler
as `TerrainBed.bedrock` for spatial data. The grid takes precedence and both solvers share their cell.
Soil loads and wheel pose records can live in another `WebAssembly.Memory` when their registered
regions name that memory. Terrain shares the bed's signed origin. Invalid input or a nonfinite
contact trial leaves the last accepted relief, pressure, loads, dust, budget and unloading history intact.

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

Both tiers accept `hardpan` for a prepared layer over denser material. Set `thickness` in metres below
the original bed and provide the lower layer's `frictionalModulus`. Set `hardpanDepths` to a vertex array or
coordinate sampler to vary the thickness across the bed. The solver samples that grid at the centre of each
footprint and uses `thickness` outside its bounds. The optional `cohesiveModulus` and
`exponent` default to 0 and 1. Footprint width and topsoil friction determine when the pressure cone reaches
the hardpan. Omit `hardpan` for a homogeneous pressure fit.

For a driven rigid wheel, use `rollingWheels` in the resolved solver's parameters, with one entry per external
load row. For example, `rollingWheels: [{ radius: 0.15735, lugHeight: 0.01, lugSupport: 0.0015, slipExponent: 0.72 }]`
is the geometry and slip fit for the 2011 Wh32 test wheel. Pass `null` for each other external row.
`SoilContactRigidSolver` supplies forward motion, load and signed shear displacement. The rolling model
finds the loaded arc and uses the computed contact length. Set a measured topsoil exponent and shear fit.
`peakFraction`, `peakSlip` and `exitFraction` default to 0.4, 0.3 and 0. Use the same modes as the
[executable moving-wheel example](tests/coupling/terramechanics.test.js).

Set `lugCount` and `lugWidth` with `lugHeight` to cut individual evenly spaced grouser marks. Pass the
same descriptor from `soilWheelPhaseField()` as `wheelPhase` to both the rigid adapter and the resolved
solver. The adapter publishes each real wheel's spin angle. Resolve lug width on both the projected
profile and the physical terrain grid.

For an irregular wheel, give the same `rollingWheels` row a `treadMesh` with flat `positions` triples
in metres (across, up, forward relative to the axle) and zero-based `indices` in triangle triples.
Use `treadMesh` or `lugCount` per row and retain the `wheelPhase` binding. The solver projects the
lowest rotating triangle at each sample and combines it with the rim profile. Set `columns` and
`rows` to resolve the narrowest groove. They default to 17 across and 65 along travel. The
[indexed tread example](tests/coupling/terramechanics.test.js) has a two-triangle wheel segment and both phase positions.

Pass the same `soilWheelCamberField()` descriptor as `wheelCamber` to both solvers to tilt the
indexed tread with the steered wheel. Its f64 row is the vertical component of the wheel's unit
right axis. Positive values raise that side. For a cylindrical wheel, the same field lets the
solver sample the live bed at the two projected rim edges and resolve deeper contact on one side.
The pressure field integrates to the prescribed wheel load. The analytic bearing arc remains
the force reference along the wheel. Omitting the field uses an upright wheel profile.

Pass `wheelReaction: soilWheelReactionField()` to `Terramechanics.load` to publish one resolved
load record per external row. `SOIL_WHEEL_REACTION_WORDS` is the number of f64 values in each
layout-1 record: vertical force in N, drawbar force in N along the wheel's forward direction and
resisting axle torque in N·m. Rows without a loaded rolling wheel contain zeros. The reaction uses
the published rolling-wheel arc. Pass the same field as `wheelReaction` to
`SoilContactRigidSolver` to apply both components on its registered `BedCollider`. Configure a tyre
model on those wheels to give them independent spin. On powered forward contact, the drawbar impulse
acts on the chassis and the axle moment slows the wheel. The tyre supplies lateral grip and contacts
outside this model's range. A lower current load scales the previous reaction before application.
The [reciprocal wheel example](tests/coupling/terramechanics.test.js) constructs the matching fields and wheel.

Set a measured `skidExponent` on the rolling wheel to enable forward skidding, including a locked
wheel. Zero enables its shear model with a constant bearing exponent. Set the corresponding rigid
binding's `shearRadii` in metres to obtain the signed slip from actual surface and ground speed,
including at crawl speed. Negative resisting torque spins up a skidding wheel while the terrain
reaction slows the chassis.

To couple sideways soil loading, pass the same descriptor from `soilWheelSideForceField()` as
`wheelSideForce` to both solvers, alongside `wheelReaction`. Each external row publishes one f64
force in N along the wheel's right axis. The resolved model combines sideways rim shear and
sidewall earth pressure. It uses the prepared soil's density and `sidewallGravity`, which defaults
to 9.81 m/s². The rigid wheel applies the force at the contact and limits it to oppose side slip.
Set a measured `lateralShearLength` on prepared soil to use separate transverse and longitudinal
mobilization on the forward rolling rim. Omit it for the combined shear model.
[FJS-1 directional side-load calibration example](tests/coupling/terramechanics.test.js).

Set a rolling wheel's `bermProfile` to `'cross-track'` to form two soil banks beside its path.
The projected wheel geometry splits the uncompacted material at oblique angles. Material is
placed using the prepared soil's repose slope and the exact terrain vertex areas. The banks
continue settling after the wheel passes. A bank outside the modeled terrain is accounted as
exported soil. The default `'ring'` is a compact local deposit and also applies at zero repose slope.

Set `grouserFill` on a cross-track wheel to the effective fraction of its lug envelope carrying
soil. The default is zero. The turning lugs return part of the loose cut into the rear footprint.
At large obliquity, they move that share to the opposite bank instead. A locked wheel carries no soil.
The returned amount is limited to the loose cut and the solver's remaining depression behind
the wheel. On nearly straight passes, the deepest part fills first to form a level bottom.
At intermediate angles, the projected trailing lug edge makes a step within the trench.
Later passes can fill earlier cuts, and the same pressure footprint counts each excavation depth only once.

Enable `grouserDig: true` to let a spinning wheel excavate beyond its initial bearing cut.
It defaults to false. Set a positive `lugHeight` and `grouserFill`, and connect the same
`wheelPhase` field to the rigid and soil solvers. Pass each wheel's continuous spin angle in
radians. Only spin travel under positive slip contributes. The cut respects bedrock and
uses the existing compaction, airborne fines and berm ledger.
[Executable spinning-wheel example](tests/coupling/terramechanics.test.js).

```ts
import { SoilContactRigidSolver, soilPatchField, soilWheelPhaseField, soilWheelPoseField, soilWheelReactionField, Terramechanics } from '@margoengine/physics/terramechanics';

const terrain = { columns: 64, rows: 64, width: 4, depth: 4, centre: [0, 0] as const };
const input = soilPatchField();
const wheelPhase = soilWheelPhaseField();
const wheelPose = soilWheelPoseField();
const wheelReaction = soilWheelReactionField();
const soil = await Terramechanics.load({ tier: 'resolved', input, wheelPhase, wheelReaction });
const rigid = new SoilContactRigidSolver(input, { terrain, wheelPhase, wheelReaction, wheelPose });
console.log(rigid.describe().id, soil.describe().id);
```

The optional `wheelPose` field restores immediately with the world snapshot. Read the layout-1 f64
rows from the registry. Each wheel row gives the chassis-local hub position XYZ in metres, local
quaternion XYZW, signed spin in rad/s, angle in radians and normal load in N. Compose the hub pose
with the accepted chassis transform. Rows follow the soil patch ordering. Belt slots contain zeros.
[Executable accepted-pose example](tests/terramechanics-film.fixture.js).

Use `ResistiveSoil` when forces should follow the shape, depth and velocity of a moving leg
through dry grains. It reads the active bed, integrates the published anisotropic stress law
on thin strips, and returns the force and moment to the real rigid body. Supply the nine
Fourier coefficients from a separate plate experiment in N/m³. Each strip samples 30
midpoints by default. To form a curved leg, chain short strips. They resolve motion in the
vertical plane perpendicular to local +Z projected onto the horizontal.

```ts
import { Physics } from '@margoengine/physics';
import { TerrainBed } from '@margoengine/physics/earth';
import { ResistiveSoil } from '@margoengine/physics/terramechanics';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';

await Physics.load();
using soil = await ResistiveSoil.load({ threads: 1 });
const terrain = { columns: 8, rows: 8, width: 0.24, depth: 0.22, centre: [0, 0] as const };
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
using physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 60, gravity: [0, 0, 0] });
const leg = physics.addBody(null, {
  position: [0, 0.02, 0],
  linearVelocity: [-0.01, -0.01, 0],
  colliders: { shape: 'sphere', radius: 0.02, mass: 1 },
});
world.add(new TerrainBed(), { ...terrain, elevations: () => 0 });
world.add(new RigidSolver(), { physics });
world.add(soil, {
  terrain,
  coefficients: [51_000, 47_000, 53_000, 83_000, 20_000, -26_000, 57_000, 0, 25_000],
  bodies: [{ row: leg.row, strips: [{ start: [0, 0, 0], end: [0, -0.0762, 0], width: 0.0254 }] }],
});
world.couple(['bed', 'rigid', soil.id], 'staggered');
world.advance(2);
console.log(soil.read(leg.row).force);
```

The example uses the measured loosely packed poppy-seed coefficients from Li, Zhang
and Goldman (2013), Table S2. The load acts on the next rigid step. The separately
measured rotating-leg experiment checks both lift and thrust.
[Rotating-leg validation](tests/coupling/resistive-soil.test.js).

`threads` defaults to one native participant. Choose two or four with a shared-memory world
in Node or a cross-origin-isolated browser. Helpers evaluate disjoint pairs of submerged
samples. The parent sums the forces and moments in the same strip order on all participant
counts. `soil.readNativeWork()` reports the joined sample counts after an accepted step.
Dispose the solver when the world stops to release its helpers.

Set `material.unloading` to give the soil a recoverable part of its settlement.
`unloading.stiffness` is the measured initial unloading slope in Pa/m, and
`hardening` is its measured increase with peak depth in Pa/m², default zero.
The surface rebounds when a load falls or leaves its footprint and follows the same
elastic line when the load returns. Only the permanent part makes a rut, berm or dust.
Omitting the option gives fully permanent indentation.

```ts
import { TerrainBed } from '@margoengine/physics/earth';
import { Terramechanics } from '@margoengine/physics/terramechanics';
import { PhysicsWorld } from '@margoengine/physics/world';

const terrain = { columns: 8, rows: 8, width: 0.8, depth: 0.8, centre: [0, 0] as const };
const soil = await Terramechanics.load({ tier: 'resolved' });
const bed = new TerrainBed();
const world = new PhysicsWorld();
world.add(bed, { ...terrain, elevations: () => 0 });
world.add(soil, {
  terrain,
  material: {
    cohesiveModulus: 0, frictionalModulus: 100_000, compaction: 1,
    unloading: { stiffness: 400_000, hardening: 2_000_000 },
  },
  patches: [{ x: 0, z: 0, length: 0.3, width: 0.3, load: 900 }],
});
world.couple([soil.id, 'bed'], 'staggered');
world.advance(1);
console.log(bed.bed.sample(0, 0).elevation, soil.budget.compacted);
```

[Live loading, unloading and plate travel examples](tests/coupling/soil-unloading.test.js).

## Granular material points

Use the optional `@margoengine/physics/granular-mpm` entry for sand that yields under
shear and snow that compacts under load. Both materials transfer mass and momentum
through sparse quadratic grid supports. The module loads its SIMD kernel on demand.

```ts
import { TerrainBed } from '@margoengine/physics/earth';
import { GranularMpmSolver } from '@margoengine/physics/granular-mpm';
import { PhysicsWorld } from '@margoengine/physics/world';

const sand = await GranularMpmSolver.load({ projectBed: true });
const surface = new TerrainBed();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
world.add(surface, { rows: 2, columns: 2, width: 1, depth: 1, centre: [0, 0] as const, elevations: () => 0.1 });
world.add(sand, {
  points: Array.from({ length: 12 }, (_, i) => ({
    position: [(i % 4) * 0.04, 0.16 + Math.floor(i / 4) * 0.04, 0] as [number, number, number],
    velocity: [0.12, 0, 0] as [number, number, number],
    volume: 0.000064,
  })),
  floor: 0,
  bedSurface: surface.bed,
});
world.couple([sand.describe().id, surface.describe().id], 'staggered');
world.advance(10);
console.log(sand.sample(0).position, surface.bed.elevations);
```

Points can select a material table row. Sand defaults to 1600 kg/m³ density,
110 kPa Young modulus, 0.2 Poisson ratio, a 34° internal friction angle and
zero cohesion. Snow defaults to 400 kg/m³, 140 kPa and the same Poisson ratio,
with 2.5% compressive yield, 0.75% tensile yield and a hardening coefficient of 10.
Supply measured material parameters where available. The defaults are illustrative.

For dense dry grains with a measured rate-dependent friction curve, supply
`materials[].inertial`. It takes the grain diameter and true grain density, the
low- and high-rate stress ratios, and the reference inertial number. This uses
implicit μ(I) shear friction in place of the static `frictionAngle`. Use zero
cohesion for this material. The example uses the glass-bead friction curve from
[Jop, Forterre and Pouliquen (2006), Figure 1](https://doi.org/10.1038/nature04801).

```ts
import { GranularMpmSolver } from '@margoengine/physics/granular-mpm';
import { PhysicsWorld } from '@margoengine/physics/world';

const grains = await GranularMpmSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
world.add(grains, {
  points: [{ position: [0, 0.2, 0], volume: 0.000064 }],
  materials: [{ inertial: {
    grainDiameter: 0.00053, grainDensity: 2500,
    staticFriction: 0.3819, highRateFriction: 0.6435, referenceInertialNumber: 0.279,
  } }],
  floor: 0,
});
world.advance(6);
console.log(grains.sample(0).position); // the material point falls in metres
```

The grid spacing defaults to 0.08 m and APIC retains local affine motion. Set
`transfer: 'pic'` for the more dissipative profile. A caller can set a dyadic clock
`rate`; otherwise the solver chooses a level from the initial material stiffness,
speed and a 3 m/s speed margin. Reduce stiffness or increase the clock when the elastic
CFL condition rejects a step. `bed` takes the common terrain sampler. With neither
`bed` nor a horizontal `floor`, the domain is open. Ground friction defaults to 0.55.
The origin cell length defaults to 4,096 m and matches the corresponding world option.
The output rows expose positions, velocities, affine velocity, elastic deformation
and material state for sampling and rendering. To make a shallow material layer
change an existing terrain surface, load with `projectBed: true` and provide its
`bedSurface` in the solver settings. Give the particles a separate support floor or
bedrock bed. The solver records the starting layer and publishes each change in
column volume through `bedChange`, so relief persists on the existing terrain.
Load with `bedWakes: true` as well to accept the swimming solver's real water-side
impulses. By default the active layer extends one grid spacing around the bed
surface and receives 5% of the impinging impulse as distributed tangential shear.
Set `wakeDepth` or `wakeFraction` to supply other measured values.

```ts
import { TerrainBed } from '@margoengine/physics/earth';
import { GranularMpmSolver } from '@margoengine/physics/granular-mpm';
import { SwimSolver } from '@margoengine/physics/life';
import { PhysicsWorld } from '@margoengine/physics/world';

const [ray, sand] = await Promise.all([
  SwimSolver.load(),
  GranularMpmSolver.load({ projectBed: true, bedWakes: true }),
]);
const surface = new TerrainBed();
const world = new PhysicsWorld();
world.add(surface, { rows: 4, columns: 4, width: 1, depth: 1, centre: [0, 0] as const, elevations: () => -0.48 });
world.add(ray, {
  bodies: [{
    position: [0, -0.2, 0], mass: 21.47, length: 1, width: 0.2, height: 0.2,
    tail: { amplitude: 0, span: 0.16, wavelength: 0.85 },
    fins: { area: 0.05, strokeAmplitude: 0.2, strokeFrequency: 1 },
  }],
});
world.add(sand, {
  points: Array.from({ length: 100 }, (_, i) => ({
    position: [(i % 10 - 4.5) * 0.04, -0.52, (Math.floor(i / 10) - 4.5) * 0.04] as [number, number, number],
    volume: 0.000064,
  })),
  floor: -0.56,
  bedSurface: surface.bed,
});
world.couple([ray.describe().id, sand.id, surface.describe().id], 'staggered');
world.advance(20);
console.log(sand.wakeImpulse, surface.bed.elevations);
```

## Physical strand guides

Use `@margoengine/physics/strands` to solve guides for hair, fur, feather shafts, and spring-bone
chains. A guide is a centreline in metres, with a material frame and both velocities per point.
Give each root an anchor sampled at the world time to follow an animated skin. The rest root is the
default stationary anchor.

```ts
import { StrandSolver } from '@margoengine/physics/strands';
import { PhysicsWorld } from '@margoengine/physics/world';

const strand = await StrandSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(strand, {
  strands: [{
    points: [[0, 1.7, 0], [0, 1.6, 0.03], [0, 1.5, 0.06]],
    sections: [{ radius: 90e-6 }, { radius: 55e-6 }],
  }],
});
world.advance(30);
console.log(strand.sample(0, 2).position);
```

The default `'rod'` tier resolves stretch, shear, bend, and twist with XPBD. Its direct
projection solves all linked constraints together in a banded system. Set `rodSolve: 'local'`
to select the sequential profile. The `'follow'`
tier keeps the authored segment lengths with one dynamic follow-the-leader pass. Use it for
dense guide sets when elastic frames and point self contact are unnecessary.

- A guide defaults to a 40 μm radius, 1,300 kg/m³ density, a 3 GPa Young modulus, and a shear
  modulus of E / 2.6. The default projected drag width is the diameter, with a coefficient of 1.2.
  Supply measured values for a shaft, bundle, or specific fibre. Wider vanes can use a separate
  `dragWidth`.
  For a tapered or hollow shaft, give `sections` one object per centreline link.
  A section inherits the guide defaults. It can specify contact radius and drag width
  separately from load-bearing area, mean transverse second moment and torsion constant.
  Use square metres for area and metres to the fourth power for both moments.
- The default rate is level 2 (240 Hz), with six direct rod passes or twelve sequential
  passes, 2/s damping, 0.9 follower correction
  and a Coulomb contact coefficient of 0.25. The rod tier defaults to point self contact.
- `wind` takes the common air field; the default is still air at 1.225 kg/m³. `bed` takes
  the common terrain surface; omitting it leaves ground contact disabled. Each `colliders`
  element is a capsule, sphere, or time-sampled capsule in the strand's origin cell. The
  origin cell length defaults to 4,096 m and must match the world's `cellSize` when customized.
- `field` publishes `STRAND_LAYOUT` in the world registry. Each `STRAND_WORDS`-word f64 record
  stores centreline position, linear velocity, XYZW material frame and angular velocity in that
  order. Each field carries the solver's signed cell, including after a change of world origin.
  Give the same deterministic anchor, wind, and body functions to playback and snapshot replay.

For a dynamic capsule or sphere, give `StrandSolver.load({ rigidCapsules })` its rigid body
row, local endpoints and radius. Add the `RigidSolver` first so the strand solver can size its
reaction field. Couple the two solvers at the same rate. With staggered rigid-then-strand
stepping, the accumulated reaction enters the next rigid step. Contact reactions include
linear impulse and the moment about the body's centre of mass. The rod tier uses the
body's inverse mass and angular inertia at the contact witness. The strand's contact
position correction is separate from its velocity impulse. A fixed root carries the
reaction corresponding to its share of the link contact.

```ts
import { Physics } from '@margoengine/physics';
import { StrandSolver } from '@margoengine/physics/strands';
import { PhysicsWorld, RigidSolver } from '@margoengine/physics/world';

await Physics.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, 0, 0] });
using rigid = new Physics(null, { arena: world.arena, gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
const body = rigid.addBody(null, {
  position: [0.14, 0, 0],
  linearVelocity: [-3.6, 0, 0],
  colliders: { shape: 'sphere', radius: 0.1, mass: 2 },
});
world.add(new RigidSolver(), { physics: rigid });
using strand = await StrandSolver.load({
  rigidCapsules: [{ body: body.row, start: [0, 0, 0], end: [0, 0, 0], radius: 0.1 }],
});
world.add(strand, { strands: [{ points: [[0, 0.3, 0], [0, 0, 0]], radius: 0.01 }], rate: 0 });
world.couple(['rigid', strand.id], 'staggered');
world.advance(2);
console.log(body.linearVelocity, strand.sample(0, 1).velocity);
```

Set `contactGeometry: 'segments'` in the rod tier to resolve contacts along the whole
guide link at each substep. When `selfCollision` is on, two nonadjacent links also collide
and exchange contact and friction impulses. A registered rigid capsule receives the
matching linear and angular impulse. Choose `'swept'` to test both body and self contacts
along linear endpoint trajectories between substeps. Use a higher rate for fast rotation
to sample the arc more closely. The default is `'points'`.

Native point prediction uses one participant by default. Set `threads: 2` or `threads: 4` on
`StrandSolver.load` with shared world memory in Node or an isolated browser worker. Inertial and
drag prediction processes pairs of points with SIMD. Constraints and contacts retain their existing
order. `readNativeWork()` reports the current accepted substep's work. Stop advancing the world before
disposing the solver. Invalid wind, bed, rigid fields or trial values leave the preceding centreline,
frames and impulses intact. [Strand error remedies](https://margoengine.com/errors#strands)

## Depth-averaged natural granular flow

Load `GranularFlowSolver` for dry slides, dense snow or a bulk granular release with prescribed basal pore support. It advances vertical layer depth and both horizontal discharges over a fixed or live bed. An initial release takes one depth in metres per cell. X varies fastest.

```js
import { TerrainBed } from '@margoengine/physics/earth';
import { GranularFlowSolver } from '@margoengine/physics/granular-flow';
import { PhysicsWorld } from '@margoengine/physics/world';

const grid = { columns: 16, rows: 4, width: 16, depth: 4, centre: [8, 2] as const };
const flow = await GranularFlowSolver.load({ liveTerrain: true });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
  .add(new TerrainBed(), { ...grid, elevations: (x) => -0.125 * x })
  .add(flow, {
    grid,
    depth: Float64Array.from({ length: 64 }, (_, i) => i % 16 < 4 ? 0.8 : 0),
    friction: 0.06,
  });
world.advance(120);
console.log(flow.sample(5, 2).depth, flow.mass);
```

The boundary is closed. The grid cells hold vertical depth in metres, X and Z discharge in m²/s and bed elevation in metres. `mass` reports kilograms from the material's constant density. `flowField` publishes the same row-major values through `GRANULAR_FLOW_LAYOUT`. The world stores the state, and its snapshots capture the runout and step count. Pass the same rectangular shape and world cell to the `TerrainBed` and the flow. For a fixed bed, omit `liveTerrain` and give the bed elevations in `bed`. The dry basal friction coefficient defaults to 0.35. `poreSupport` is a prescribed fraction of grain contact load taken by pore pressure, from zero (dry) to one. The Voellmy coefficient defaults to 2,000 m/s². Set `turbulence: Infinity` for pure Coulomb. Bulk density defaults to 1,600 kg/m³. The world provides downward gravity.

For rough dry granular beds, use `roughness: 'glass-beads'` in place of `friction`. The default roughness option is absent, which selects the constant-friction Voellmy tier. The named profile is measured for 0.5 mm glass beads and uses the 2002 rational stopping curve. Pass a `GranularRoughness` with the measured start and stop angles, characteristic thickness and `beta` for a different rough bed. Set `curve: 'exponential'` for the 1999 stopping fit. The low-speed exponent defaults to 0.001, and turbulent drag defaults to disabled for this tier. A static layer uses the starting curve, while faster layers use the stopping curve at a Froude-adjusted thickness.

Use `depositToTerrain: true` at load time to also move arrested layers into the registered `TerrainBed`. The pressure gradient and bed slope must be under the material stopping threshold. Roughness materials also require a Froude number below their steady-flow threshold. The default `deposition.stopSpeed` of 0 transfers fully stopped material. A positive speed allows a small remaining motion to be absorbed by the fixed bed. `deposition.density` defaults to the moving density and can be higher for compaction. Couple `granularFlow` before `bed` to apply the deposit on the same tick. The next flow step reads the new bed. For this accumulating world, take a checkpoint after the first complete frame so the shared sum region is present.

```js
import { GranularFlowSolver } from '@margoengine/physics/granular-flow';
import { PhysicsWorld } from '@margoengine/physics/world';

const grid = { columns: 65, rows: 3, width: 0.65, depth: 0.03, centre: [0, 0] as const };
const angle = 23.3 * Math.PI / 180;
const flow = await GranularFlowSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(flow, {
  grid,
  bed: Float64Array.from({ length: 195 }, (_, i) => -Math.tan(angle) * (i % 65 - 32) * 0.01),
  depth: 0.0035 / Math.cos(angle),
  roughness: 'glass-beads',
  velocity: [0.02 * Math.cos(angle), 0],
});
world.advance(6);
console.log(flow.sample(32, 1).discharge);
```

```js
import { TerrainBed } from '@margoengine/physics/earth';
import { GranularFlowSolver } from '@margoengine/physics/granular-flow';
import { PhysicsWorld } from '@margoengine/physics/world';

const grid = { columns: 3, rows: 2, width: 3, depth: 4, centre: [0, 0] as const };
const bed = new TerrainBed();
const flow = await GranularFlowSolver.load({ depositToTerrain: true });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
  .add(bed, { ...grid, elevations: new Float32Array(12) })
  .add(flow, { grid, depth: 0.5, density: 300, deposition: { density: 400 } })
  .couple(['granularFlow', 'bed'], 'staggered');
world.advance(2);
console.log(bed.volume(), flow.depositBudget.mass);
```

Enable `marineDisplacement` for a natural coastal release and pass `seaSourceField` to the receiving `TsunamiSolver`. `seaLevel` defaults to 0 metres in the shared world cell. The resulting volume is signed when material enters water, leaves it or compacts. The initial submerged volume establishes the baseline. Supply the receiving water solver with its reference bathymetry when the source includes the growing granular deposit.

```js
import { GranularFlowSolver } from '@margoengine/physics/granular-flow';
import { TsunamiSolver } from '@margoengine/physics/tsunami';
import { PhysicsWorld } from '@margoengine/physics/world';

const grid = { columns: 28, rows: 3, width: 28, depth: 3, centre: [14, 1.5] as const };
const bed = Float64Array.from({ length: 84 }, (_, i) => Math.max(-1.25, 0.4375 - (i % 28) * 0.125));
const flow = await GranularFlowSolver.load({ marineDisplacement: true });
const sea = await TsunamiSolver.load({ sources: [flow.seaSourceField] });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
  .add(flow, {
    grid, bed, friction: 0.07, velocity: [1.5, 0],
    depth: Float64Array.from({ length: 84 }, (_, i) => i % 28 < 3 ? 0.8 : 0),
  })
  .add(sea, { cells: [28, 3], spacing: 1, bathymetry: bed });
world.advance(180);
console.log(flow.marineBudget.displacedVolume, sea.budget.admittedSourceVolume);
```

To drive a slide with elastic ground motion, load with `groundField: ground.groundField` from a registered `SeismicGround` in the same world cell. This option defaults to absent. The solver interpolates the X/depth cross-section along X and extends that section across the flow grid along Z. X ground acceleration drives relative motion in the opposite direction. Upward ground acceleration increases the normal contact load.

```js
import { GranularFlowSolver } from '@margoengine/physics/granular-flow';
import { SeismicGround } from '@margoengine/physics/seismic';
import { PhysicsWorld } from '@margoengine/physics/world';

const ground = await SeismicGround.load();
const flow = await GranularFlowSolver.load({ groundField: ground.groundField });
const grid = { columns: 39, rows: 3, width: 39, depth: 3, centre: [19.5, 0] as const };
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
  .add(ground, {
    width: 39, depth: 18, spacing: [1, 1],
    material: { density: 2200, compressionalSpeed: 35, shearSpeed: 20 },
    initialVelocity: (x) => [0.1 * Math.sin((2 * Math.PI * x) / 16), 0],
  })
  .add(flow, { grid, depth: 0.25, friction: 0.015 });
world.advance(12);
console.log(flow.sample(19, 1).discharge);
```

## Breakable objects

`@margoengine/physics/breakable` breaks convex objects (any closed convex mesh, a glTF mesh's `Geometry` included, or a
box) into convex rigid pieces when something hits them hard enough: a ball through a wall, a crate dropped on a floor,
a blast. Quick start, a ball through a wall:

```ts
import { Physics } from '@margoengine/physics';
import { BreakableWorld } from '@margoengine/physics/breakable';

await Physics.load();
const physics = new Physics(null);
const wall = new BreakableWorld(physics).add(null, { size: [2, 2, 0.3], position: [0, 1, 0], anchors: 'bottom' });
const ball = { shape: 'sphere', radius: 0.3, density: 400 } as const;
physics.addBody(null, { position: [0, 1.2, 2], linearVelocity: [0, 0, -20], colliders: ball });
for (let i = 0; i < 60; i++) physics.step();
console.log(wall.broken, wall.fragments.length);
```

How it works. The object is cut into convex Voronoi cells (`cellCount` of them, seeded, so the same seed gives the
same pieces), either up front (`fractureMode: 'prefractured'`, the default) or at the first breaking hit, clustered
around the hit point (`'impact'`). Neighbouring cells are joined by bonds across their shared face; each bond holds an
impulse (`bondStrength`, N s, scaled by its face's area over the mean). Until a bond breaks the object is one rigid
body, so it rests without jitter. Every contact on it takes damage off the bonds near the contact point: the rise of
the pair's normal impulse over its last step, so a load it carries (its own weight, a stack on top, a steady push)
wears nothing, times a falloff of `1 - distance / impactRadius`. When bonds break, the cells fall into islands across
the bonds left; an island with an anchored cell stays fixed, and every other island becomes a dynamic body with the
cells' own convex hulls as its collider and the exact mass, centre of mass and inertia of its polyhedra (Mirtich 1996)
at the material's `density`, moving as the object did at that point (`v + w x r`). Islands break again on later hits.
`applyImpact(point, impulse, radius?)` and `applyExplosion(center, impulse, radius)` damage and push the same way from
code.

Body options (`breakable.add(mesh, options)`, `mesh` may be `null`): `size` (box size in m; default the mesh's bounds,
or 1 m), `geometry` (a convex mesh to break, read as its convex hull; default the mesh's), `position` and `rotation`
(default the mesh's, or the origin), `type` (`'fixed'` when anchored, else `'dynamic'`), `fractureMode`
(`'prefractured'`), `cellCount` (12, from 2 to 256), `sites` (your own cell centres, local), `pattern` (`'uniform'`,
`'brick'` or `'radial'`; default `'uniform'`), `seed` (1), `bondStrength` (25 N s), `bondStrengthFn` (a strength per
bond), `areaWeightedStrength` (true; the weight is held to 0.35 to 2.5 times), `minImpactImpulse` (the larger of 0.5
N s and a fifth of `bondStrength`), `impactRadius` (0.45 of the largest size, at least 0.25 m), `anchors` (`'none'`;
or `'bottom'`, `'perimeter'`, `'all-boundary'`, cell indices, or a test per cell), `anchorTolerance` (0.06 of the
size), `density` (1 kg/m³, as Rapier's), `friction` (0.5), `restitution` (0.15), `material` and `interiorMaterial`
(the pieces' outside and cut faces; default the mesh's material and none), `uvScale` (1 per m), `collisionGroups`,
`debrisCollisionGroups`, `splitIslands` (false: a loose island stays one body), `secondaryFracture` (true), `onBreak`
and `userData`.

World options (`new BreakableWorld(physics, options)`): `engine` (for the pieces' meshes; default the first mesh's),
`maxDebris` (128 live pieces, the oldest sleeping one goes first), `debrisLifetime` (30 s, or `Infinity`),
`debrisSleepThreshold` (0.15 m/s), `debrisAngularSleepThreshold` (0.25 rad/s), `debrisSleepTime` (0.4 s: a piece
slower than both for that long sleeps), `debrisCollisionGroups` and `onBreak`. `reset()` puts every object back whole,
`dispose()` (or `using`) removes everything it made.

Debug view: `breakable.debugRender({ cells, bonds, anchors, debris })` gives `{ vertices, colors }` line segments, the
same shape as `physics.debugRender()`, for `@margoengine/lines` (`new Line({ mode: 'segments', positions: vertices,
colors })`): cell seams, bonds from green (whole) to red (about to break), anchor pins, and pieces orange while awake
and grey asleep.

Deterministic: the same inputs give the same pieces and the same state. `breakable.takeSnapshot()` with
`physics.takeSnapshot()`, restored with `restoreSnapshot` on both, steps on to the same bits; a snapshot is for the
pieces live when it was taken, so take it after the last break. The fracture helpers `voronoiFractureBox`,
`voronoiFractureGeometry`, `voronoiFracturePolyhedron` and `computePolyhedronMassProperties` give the cells and their
mass properties without a world.

What it does not do (`docs/limits.md`): a concave mesh breaks as its convex hull (split it with `convexDecomposition`
first); damage is an impulse budget per bond, not a stress or energy model; cut faces are flat. See
[`examples/physics-breakable.html`](../../examples/physics-breakable.html) for a stone pillar, a brick wall and a framed
glass pane to shoot at, with the debug view.

## Joints and motors

Every joint of the rigid world, with limits and motors on each axis it leaves free. Quick start, a door on a hinge that a
motor swings open to its stop:

```ts
import { Physics } from '@margoengine/physics';

await Physics.load();
const physics = new Physics(null);
const frame = physics.addBody(null, { type: 'fixed', position: [0, 1, 0], colliders: [] });
const door = physics.addBody(null, { position: [0.5, 1, 0], colliders: { shape: 'box', halfExtents: [0.5, 1, 0.03] } });
physics.addJoint(frame, door, { type: 'revolute', axis: [0, 1, 0], anchorB: [-0.5, 0, 0], limits: [0, 1.6], motor: { targetVelocity: 1, damping: 20, maxForce: 40 } });
for (let i = 0; i < 150; i++) physics.step();
console.log((2 * Math.atan2(door.rotation[1], door.rotation[3])).toFixed(2)); // '1.60': open against its stop
```

The kinds (`physics.addJoint(bodyA, bodyB, options)`), each measured from its frame on body A (`frameA`, or an `axis`) to
its frame on body B:

| `type` | Free axes | Limits | Motors |
| --- | --- | --- | --- |
| `fixed` | none | none to limit | none |
| `spherical` (ball and socket) | `angX`, `angY`, `angZ` | `limits: { angY: [min, max] }`, per turn | `motors: { angZ: {...} }`, per turn; `setRotationMotor(q)` toward a rotation |
| `cone` (shoulder, hip) | the turns, inside a swing cone | `swing` (one angle or an ellipse), `twist` | `setRotationMotor(q)` |
| `revolute` (hinge) | `angX` | `limits` | `motor` |
| `prismatic` (slider) | `linX` | `limits` | `motor` |
| `pinSlot` | `linX`, `angX` | `slideLimits`, `turnLimits` | `slideMotor`, `turnMotor` |
| `rope` | `linX`, the distance | `length` (the greatest); a least one with `setAxisLimits('linX', min, max)` | `motor`, a winch |
| `spring` | `linX`, the distance | `minLength`, `maxLength`, hard stops | the spring itself (`restLength`, `stiffness`, `damping`) |
| `generic` (six axes) | what `locked` leaves | `limits`, per axis; `coupled` axes share one | `motors`, per axis |
| `motor` | all six, as springs to a pose | caps `maxForce`, `maxTorque` | `linearOffset`, `angularOffset` |

`new DistanceJoint(physics, a, b, { min, max, frequency })` holds two anchors between a least and a greatest distance (see
"Gear, rack and pinion, pulley, distance range"), and `physics.addMultibody(root, links)` holds a tree of these joints in
reduced coordinates, exact for robot arms and ragdolls (see "Multibody joints").

On every joint, `joint.setAxisLimits(dof, min, max)` and `joint.setAxisMotor(dof, motor)` limit and drive any axis it does
not lock (`linX`, `linY`, `linZ`, `angX`, `angY`, `angZ`; a rope's and a spring's one axis is `linX`, the distance from 0),
and `joint.axisLimits(dof)` reads a limit back (`null` for none). A motor drives toward `targetVelocity`, or as a spring
toward `targetPosition` (`stiffness` and `damping`, or `frequency` and `dampingRatio`), capped at `maxForce` (N or N m).
`setLimits` and `setMotor` are the same calls for a joint with one free axis (a hinge, a slider, a rope's winch). A spring
takes no motor on its distance, which the spring drives, and a ball joint with axis limits takes no rotation motor, which
would move the frame its limits measure from: a cone holds both. `breakForce` and `breakTorque` break a joint (see
"Breaking joints"), and `contactsEnabled` (default false) lets the two bodies it holds collide; set it later with
`joint.contactsEnabled = true`. Bad input throws a `MargoError` (code `unsupported`, or `state` for a removed joint) whose
message names the fix and links to [margoengine.com/errors#physics-joints](https://margoengine.com/errors#physics-joints).

Debug view: `physics.debugRender({ jointFrames: true })` adds, for each joint, frame A's axes at anchor A (red x, green y,
blue z, `style.jointFrameLength` metres, default 0.25) and frame B's at anchor B, and in gold (`style.jointLimit`) an arc
from min to max for each limited turn, a bar for each limited slide, a cone's swing rim, and a cross at each distance stop.
Draw the lines with `@margoengine/lines`, as the other debug lines.

What it does not do (`docs/limits.md`): limits on a ball joint's three turns are on the parts of its rotation vector, which
match angles about each axis only while one turn is large at a time (a cone holds a swing as one angle); a spring's
distance has no motor besides the spring. See [`examples/physics-joints.html`](../../examples/physics-joints.html) for a
hinged door, a motorised arm and a chain, with the debug view.
