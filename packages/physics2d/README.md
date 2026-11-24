# @margoengine/physics2d

Import `margoengine/physics2d` from the `margoengine` package, or `@margoengine/physics2d` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

2D rigid-body physics for Margo Engine on its own 2D kernel (Rust compiled to Wasm with SIMD): a fixed-step engine plugin with interpolation, bodies that drive sprites, box, circle, capsule, polygon (convex or concave) and polyline colliders, joints, scene queries, collision and contact force events, sensors, collision groups, continuous collision, a character controller and tile map colliders in one call. Nothing else to install: the kernel's WebAssembly is a file of this package, `dist/physics2d.wasm`.

World units are sprite pixels, y points down and angles are radians, clockwise on screen. `pixelsPerMeter` (default 32) maps them to the kernel's metres, so a 16 pixel tile is half a metre. Mass, density, force and impulse use kernel units (kilograms, metres, seconds).

```ts
import {Physics2D} from 'margoengine/physics2d';

await Physics2D.load();
const physics = new Physics2D(null); // or new Physics2D(engine, ...) to step with the engine

// A tile map: tiles with collision shapes (or a `solid: true` property) become one fixed body.
physics.addTileMap({
  tileWidth: 16, tileHeight: 16,
  tilesets: [{firstGid: 1, tileCount: 1, tileWidth: 16, tileHeight: 16, tiles: [{id: 0, properties: {solid: true}}]}],
  layers: [{type: 'tile', name: 'ground', width: 8, height: 4, data: new Uint32Array(32).fill(1, 24)}],
});

// A body that drives a sprite: each frame the interpolated pose is written to sprite.x, sprite.y and sprite.rotation.
const sprite = {x: 64, y: 0, rotation: 0};
const crate = physics.addBody(sprite, {colliders: {shape: 'box', width: 16, height: 16, restitution: 0.2}});
physics.on('contactstart', ({bodyA, bodyB}) => {});
physics.update(1 / 60); // or let the engine call it every frame
crate.applyImpulse([0, -2]);
physics.raycast([64, 0], [0, 1])?.point;

// A hinge with limits, and a character on a kinematic body.
const pole = physics.addBody(null, {type: 'fixed', position: [32, 8], colliders: []});
physics.addJoint(pole, crate, {type: 'revolute', anchorB: [-8, 0], limits: [-1, 1]});
const hero = physics.addBody({x: 20, y: 40, rotation: 0}, {type: 'kinematicPosition', colliders: {shape: 'capsule', radius: 5, height: 20}});
const controller = physics.createCharacterController(hero, {snapToGround: 2});
physics.on('beforestep', dt => controller.move([60 * dt, 200 * dt]));
```

It exports `Physics2D`, `Body2D`, `Joint2D`, `CharacterController2D`, `interactionGroups` and `tileMapColliders`, the collider list `addTileMap` builds. `addTileMap` accepts a `TileMapData` from `@margoengine/tilemap`, or any object of the `TileMapSource` shape. Whole-cell solid tiles merge into outline loops so bodies slide across tile seams without catching; other collision shapes (rectangles, ellipses, polygons, polylines), tile flips and layer offsets are kept. Very fast bodies on a tile map need `ccd: true`, because outlines have no thickness.

**One load per app.** `await Physics2D.load()` compiles the kernel, then `new Physics2D(engine)` stays synchronous. Later calls resolve at once, calls during a load share it, a failed load is tried again by the next call, and `{signal}` stops one caller's wait; when no other call waits on the load, it also cancels the download. The loader is a dynamic import and the Wasm a separate file (`dist/physics2d.wasm`) that bundlers emit as an asset and the browser compiles while it downloads when served as `application/wasm`. `{wasm}` points at another copy: a URL (your server or a CDN), a fetched `Response`, its bytes or a compiled `WebAssembly.Module`. It must be the bundled build; any other Wasm rejects with a `MargoError` of code `failed`, as does a missing file, and nothing is loaded.

```ts
import {Physics2D} from '@margoengine/physics2d';

// The package's own copy found through Node's resolver; in a page, pass the URL your server or CDN serves it from.
const wasm = new URL('physics2d.wasm', import.meta.resolve('@margoengine/physics2d'));
await Physics2D.load({wasm, signal: AbortSignal.timeout(30_000)});
const physics = new Physics2D(null, {gravity: [0, 320]});
physics.dispose();
```

Queries (`raycast`, `overlapPoint`, `overlapShape`, `castShape`) see every collider added or moved since the last step, and a `teleport` or `moveTo` at once. `castShape` and `overlapShape` take a box, circle, capsule, segment or a convex polygon of at most 8 points.

Apache-2.0. Optional, tree-shakable package; core peer: ^1.0.0. The kernel is Margo's own, written from papers (`docs/clean-room.md`); it holds no third-party code.

Build and unit tests: npm test --workspace @margoengine/physics2d

## Parity with Rapier 2D

`Physics2D` runs on Margo's own 2D kernel (`kernel/`, Rust to Wasm); it no longer uses Rapier. The capabilities below are listed from Rapier 2D's public user guide (rapier.rs/docs), never from its source. Status: **full** (kernel, facade and a test), **partial** (what is missing is named), **missing**. Docs: [limits](../../docs/limits.md), [known bugs](../../docs/known-bugs.md).

| Area | Rapier 2D capability | Where in Margo | Status |
| --- | --- | --- | --- |
| Shapes | ball, cuboid, capsule, segment | `box`, `circle`, `capsule`, `segment` colliders | full |
| Shapes | convex polygon, convex decomposition of concave or large input | `polygon` (convex hull to 8 corners; concave or larger split by ear clipping and Hertel-Mehlhorn) | full |
| Shapes | polyline | `polyline` (chains with ghost vertices: bodies slide over the joins) | full |
| Shapes | triangle, round (border radius) cuboid, triangle and convex polygon, trimesh | `triangle`, `borderRadius` on `box`, `polygon` and `triangle`, `trimesh` (triangles by index) | full |
| Shapes | heightfield, halfspace, compound, voxels, shared shapes | `heightfield` (a smooth chain), `halfspace` (a polygon 200,000 units across), `compound` (parts with their own placement), `voxels` (merged outlines for contact, the cells themselves for queries); shape options are plain values, so one can be reused on any number of colliders | full, with the accepted differences in limits |
| Shapes | oriented (one-sided) polyline | `polyline` with `oneSided: true` | full |
| Collision | broad phase, narrow phase, manifolds, islands, sleeping | kernel box tree, SAT and clipping, SIMD solver | full |
| Collision | continuous collision detection | `ccd` against fixed, kinematic and dynamic bodies (a dynamic one it meets is put back to the same time) | full |
| Collision | soft CCD (a prediction distance per body) | `softCcd` (world units a body's contacts reach ahead) | full |
| Collision | sensors | `sensor: true` (senses fixed and kinematic bodies too) | full |
| Collision | collision groups, solver groups, active collision types | `collisionGroups`, `solverGroups`, `activeCollisionTypes` | full |
| Collision | collision events, contact force events | `contactstart`, `contactend`, `intersectionstart`, `intersectionend`, `contactforce` (`contactForceThreshold`) | full |
| Collision | physics hooks (filter and modify contact pairs, one-way platforms) | `physics.hooks = {filterPair, modifyContact}` for colliders with `hooks` set; `oneWay`, `friction`, `restitution`, `tangentVelocity` (conveyors), `solverActive` per contact | full |
| Queries | ray cast with normal (solid or not), point, shape intersection, shape cast, project point, box intersection, filters | `raycast`, `overlapPoint`, `overlapShape`, `castShape`, `projectPoint`, `intersectionsWithBox`, `QueryFilter2D` | full |
| Queries | contact pairs of a collider | `contactPairs(collider)` | full |
| Bodies | dynamic, fixed, kinematic position, kinematic velocity | `type` | full |
| Bodies | damping, gravity scale, locked rotation, can sleep, dominance, body type changes | `BodyOptions2D`, the same names as setters on `Body2D`, `setType` | full |
| Bodies | forces, torques, impulses (at the centre or a point), velocities, wake and sleep | `Body2D` methods | full |
| Bodies | additional mass | `additionalMass` | full |
| Bodies | locked translation axes | `lockTranslation` (an exact joint constraint that follows teleports) | full |
| Bodies | soft CCD | none | missing |
| Joints | fixed, revolute, prismatic, rope, spring, limits, motors, contacts between jointed bodies | `addJoint` | full |
| Joints | generic joint (any mix of the x, y and angle locks, in turned frames), pin-slot | `type: 'generic'`, `type: 'slot'` | full |
| Joints | multibody joints: joint space, joint motors and limits, kinematics, inverse kinematics | `addArticulation` (`Articulation2D`: positions and velocities, motors, limits, forward and inverse kinematics, Jacobian); solved by the exact joint paths, not by reduced coordinates | full, with the accepted difference in limits |
| Tools | PID controller | `PidController2D` | full |
| Character | kinematic character controller: slide, autostep, snap to ground, slope climb and slide, push dynamic bodies, up vector | `createCharacterController` | full |
| World | fixed timestep, interpolation, determinism (bit-identical native and Wasm) | `Physics2D`, kernel tests | full |
| World | snapshots (serialise and restore the world) | `snapshot()`, `restore()`: a restored world steps bit for bit as the original | full |
| World | debug render data | `debugRender()` | full |
| Tools | tile map and sprite outline colliders | `addTileMap`, `outlineColliders` | full |

## Articulations

`physics.addArticulation(root, links)` joins bodies into a tree of revolute and prismatic joints and gives it a joint space: positions, velocities, motors, limits, forward and inverse kinematics.

```ts
import { Physics2D } from '@margoengine/physics2d';

await Physics2D.load();
const physics = new Physics2D(null, { gravity: [0, 0] });
const base = physics.addBody(null, { type: 'fixed', colliders: [] });
const link = (x: number) => physics.addBody(null, { position: [x, 0], colliders: { shape: 'box', width: 40, height: 6, collisionGroups: 0 } });
const [upper, lower] = [link(20), link(60)];
const arm = physics.addArticulation(base, [
  { body: upper, joint: { type: 'revolute', anchorChild: [-20, 0], limits: [-2.5, 2.5] } },
  { body: lower, parent: 0, joint: { type: 'revolute', anchorParent: [20, 0], anchorChild: [-20, 0], limits: [-2.5, 2.5] } },
]);
// Joint positions that put the lower arm's tip on a point, then let the motors take the arm there.
const { q, reached } = arm.solveIK(1, [20, 0], [50, 40]);
arm.driveTo(q);
for (let i = 0; i < 240; i++) physics.step();
console.log(reached, arm.pointAt(1, [20, 0]));
physics.dispose();
```

The links stay ordinary bodies and the kernel's joints hold them together (exactly along chains), so contacts of any link act on the whole arm; see [limits](../../docs/limits.md) for how this differs from reduced coordinates.

## Colliders from a sprite's alpha (`@margoengine/physics2d/outline`)

`outlineColliders(image, options)` turns the alpha of an image into colliders that follow what is drawn, holes and hollows included, so a ball can rest in a cup. `image` is RGBA8 straight alpha, row by row from the top: `ImageData` fits.

```ts
import { Physics2D } from '@margoengine/physics2d';
import { outlineColliders } from '@margoengine/physics2d/outline';

// Any drawing works; drawImage a sprite here.
const context = new OffscreenCanvas(64, 64).getContext('2d')!;
context.arc(32, 32, 24, 0, Math.PI * 2);
context.fill();
const imageData = context.getImageData(0, 0, 64, 64);

await Physics2D.load();
const physics = new Physics2D(null, { gravity: [0, 980] });
const colliders = outlineColliders(imageData, { friction: 0.4 });
physics.addBody(null, { type: 'fixed', colliders });
```

Pass `sprite` and the colliders land on the sprite's pivot and scale, and its `rect` picks the frame of an atlas: `physics.addBody(sprite, {colliders: outlineColliders(imageData, {sprite})})`. `traceOutlines(image, options)` gives the outlines alone, in pixels from the top left of the traced area, each with its holes.

| Option | Default | What it does |
| --- | --- | --- |
| `threshold` | 128 | Alpha from 1 to 255 that counts as solid; the edge is placed between pixels by their alpha |
| `tolerance` | 1 | Farthest the thinned outline may stray from the traced one, in pixels; 0 keeps every point off a straight line |
| `minArea` | 4 | Outlines and holes under this many square pixels are left out |
| `rect` | whole image | `[x, y, width, height]` in pixels |
| `sprite` | none | Places the colliders, as `addBody(sprite)` places a fitted box |
| `edges` | false | False gives filled convex `polygon` colliders; true gives one closed `polyline` per outline and hole, for fixed terrain |

Any other collider setting (`friction`, `restitution`, `sensor`, `density` and the rest) goes on every collider. Limits are in [docs/limits.md](../../docs/limits.md).

## Kernel development

The Rust kernel under `kernel/` is what the TypeScript facade above calls through `dist/physics2d.wasm` (its C interface is `kernel/src/api.rs`; rebuild the committed Wasm with `node scripts/wasm-blueprints.mjs --rebuild --only=physics2d-kernel`). Its world batches four
awake quad contacts through exact SIMD SAT and clipping. A rectangle certified from its current vertices and normals
uses support corners for SAT; separated cores can certify the original preferred clipped face from conservative
distance bounds. Uncertified cases use the complete closest-distance path. The
[floating-point proof](../../docs/architecture/physics2d-manifold-proof.md) describes the guards and fallback.
Other shapes, chains and short tails retain their collision paths. `manifold::collide_four` has a runnable Rust
example in [its API documentation](kernel/src/manifold/four.rs); every lane's manifold is bit-identical to the
scalar call, including signed zeros and unused point slots. Run the native and shipped Wasm checks from the root:

```sh
npm run test:physics2d-kernel
npm run check:rust-kernels -- --packages=physics2d
```

[Performance history](../../docs/whitepaper/perf-history.md) records the modest paired gain and the remaining Box2D
loss; the 0.35 ms narrow-phase target has not been met. Browser evidence covers Edge WebGPU/WebGL2 and Firefox
WebGL2; Firefox WebGPU has no adapter on the test installation.

Rapier 2D is not a dependency of this package. `tests/oracle-rapier.test.js` compares scenes with it live when `RAPIER2D_MODULE` names the `rapier.mjs` of a `@dimforge/rapier2d-compat` 0.21 you installed outside the repository (a black box, for comparison only); without it those tests are listed as not run.

### Checked Rust input

The raw Rust world and collision APIs return `Result<_, PhysicsError>`. Handle errors with `?` or inspect
`error.code()` and `error.help()`; the [input contract](../../docs/limits.md#own-2d-input-validation) lists the
codes and representability rules. This API belongs to `kernel/`; the TypeScript facade above
keeps its existing API and units.

```rust
use margoengine_physics2d_kernel::{
    error::PhysicsError,
    math::{V2, v2},
    shape::Core,
    world::{BodyDef, ShapeDef, World},
};

fn main() -> Result<(), PhysicsError> {
    let mut world = World::default();
    let body = world.create_body(&BodyDef {
        position: v2(0.0, 0.5),
        ..BodyDef::default()
    })?;
    let core = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0)?;
    world.create_shape(body, core, &ShapeDef::default())?;
    world.step(1.0 / 60.0)?;

    let error = world.create_shape(body, core, &ShapeDef {
        density: f32::INFINITY,
        ..ShapeDef::default()
    }).unwrap_err();
    assert_eq!(error.code(), "PHYSICS2D_NOT_FINITE");
    assert_eq!(world.shapes.len(), 1); // The refused shape was never published.
    Ok(())
}
```

Body, shape and whole-chain creation refuse invalid input before publishing a partial result. Finite positive
density alone is insufficient: derived mass, inertia, centres and reciprocals must also remain representable.
The inverse metric's reciprocal and the reconstructed rounded origin are checked too. Finite friction coefficients
use an overflow-safe geometric mean; used cached normal impulses cannot be negative.
Contact normal/tangent metrics are checked before inversion, including sums of individually valid inverse masses.
Rotation normalization scales exceptional finite pairs to preserve their direction across overflow/underflow;
nonfinite integration arithmetic returns the coded error. A directly mutated zero body rotation is refused.
Genuine zero density or zero area retains its documented zero-mass behavior; positive mass or inertia rounded
to zero is refused. Before stepping, the world checks current public data and handles, including edits made
after creation. A reported arithmetic error during simulation does not promise rollback of the whole step.

Direct Rust `solver::solve` calls check the same current inputs and derived solver outputs. `World::step`
uses the private already-checked solver entry after its preflight, so a normal step checks each boundary once.
Unlike the world's nonpositive-step no-op, the direct solver requires a positive representable substep.

Collision calls (`collide`, `collide_coherent`, `collide_four` and `collide_smooth`) refuse nonfinite poses or
cutoffs and invalid current core data instead of indexing a missing face or returning an invented contact.
The existing [four-pair Rust doctest](kernel/src/manifold/four.rs) demonstrates the checked collision call.
Run `cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --doc` for both examples. Native
input/manifold regression commands are in [reproduce.md](../../docs/whitepaper/reproduce.md#own-2d-input-validation).
Input validation preserves the retained manifold reference and the prior valid hashes. The separate support
correction below intentionally re-pins the mixed scene. Owned-2D CCD is separate T-11 / 127.y work.

### Sustained contact support in the owned kernel

The default 3 m/s recovery cap limits recovery demand independently of sustained elastic support. The spring
root, four substeps, one pass and all accuracy thresholds remain unchanged. A certified supported contact path
uses a coupled equilibrium correction with physical masses; general graphs retain capped contact dynamics.
Sleep also observes the motion actually integrated, so relaxation cannot hide continuing correction.

The required 1:1000 centered contact stack now holds the same 3% spring-sag, 0.1 mm top drift, 10 mm post-one-second
creep and sleep predicates as 1:100. Run `cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test world`.
All original physical bars remain required. The mixed-scene hash is deliberately re-pinned for this correction;
pyramid and joint-grid hashes stay unchanged. The [proof and method domain](../../docs/architecture/physics2d-support-proof.md)
distinguish axial support from the preserved soft model's [lateral bending limit](../../docs/architecture/physics2d-support-bending.md).
This is a correctness change; Box2D browser speed parity remains unproven.

The support planner rebuilds its current graph each frame and retains flat scratch buffers between steps.
It preserves contact order, eligibility decisions and floating arithmetic. Retained planner capacity follows
the largest body/contact counts seen by the world; changing component order cannot accumulate a separate
high-water allocation for every component. Accepted components still allocate local solve buffers.
The native `planner_allocations` example measures whole-step allocation requests on the unchanged 100-row
scene; [reproduce.md](../../docs/whitepaper/reproduce.md) records its paired-control procedure and timing limits.

The four-lane normal solver also omits finite predicates already implied by its exact caller expressions.
Its [IEEE proof](../../docs/architecture/physics2d-finite-certificates.md) states that contract and the checks
retained for mutable arithmetic, cap membership and scalar fallback. The compiled finite-predicate count
falls while all current hashes and physical bars remain unchanged; a browser speed gain is unproven.

Private broad-phase refits reuse the same call-stack input preflight while public bounds and every step
remain checked. The planner also skips pure eligibility predicates after rejecting a component, retaining
its entire traversal. The [frame-preparation proof](../../docs/architecture/physics2d-frame-preparation.md)
records exact work, accuracy and measurement limits; the Box2D browser loss remains open.

## Content Security Policy

Wasm initialization needs `'wasm-unsafe-eval'` in `script-src` on restricted pages and worker responses. Blocked compilation rejects with MargoError code `failed` and a help link. See [the exact header and package requirements](../../docs/csp.md).
