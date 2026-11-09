# @margoengine/physics2d

Import `margoengine/physics2d` from the `margoengine` package, or `@margoengine/physics2d` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

2D rigid-body physics for Margo Engine on [Rapier](https://rapier.rs): a fixed-step engine plugin with interpolation, bodies that drive sprites, box, circle, capsule and polygon colliders, joints, scene queries, collision events, a character controller and tile map colliders in one call. Rapier is not bundled: you install `@dimforge/rapier2d-compat` (Apache-2.0) yourself and pass the initialized module in.

World units are sprite pixels, y points down and angles are radians, clockwise on screen. `pixelsPerMeter` (default 32) maps them to Rapier's metres, so a 16 pixel tile is half a metre. Mass, density, force and impulse use Rapier's units.

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

Queries (`raycast`, `overlapPoint`, `overlapShape`, `castShape`) see every collider added or moved since the last step: they bring Rapier's broad phase up to date with a zero-length step first, which moves nothing and raises no events.

Apache-2.0. Optional, tree-shakable package; core peer: ^1.0.0, Rapier peer optional: `npm i @margoengine/physics2d @dimforge/rapier2d-compat`.

Build and unit tests: npm test --workspace @margoengine/physics2d

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

The in-repository Rust kernel under `kernel/` is separate from this package's Rapier facade. Its world batches four
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

### Checked Rust input

The raw Rust world and collision APIs return `Result<_, PhysicsError>`. Handle errors with `?` or inspect
`error.code()` and `error.help()`; the [input contract](../../docs/limits.md#own-2d-input-validation) lists the
codes and representability rules. This API belongs to `kernel/`; the Rapier-backed TypeScript facade above
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
