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
awake quad contacts through exact SIMD SAT and clipping; separated cores keep the original closest-distance path,
and other shapes, chains and short tails retain their collision paths. `manifold::collide_four` has a runnable Rust
example in [its API documentation](kernel/src/manifold/four.rs); every lane's manifold is bit-identical to the
scalar call, including signed zeros and unused point slots. Run the native and shipped Wasm checks from the root:

```sh
npm run test:physics2d-kernel
npm run check:rust-kernels -- --packages=physics2d
```

[Performance history](../../docs/whitepaper/perf-history.md) records the modest paired gain and the remaining Box2D
loss; the 0.35 ms narrow-phase target has not been met. Browser evidence covers Edge WebGPU/WebGL2 and Firefox
WebGL2; Firefox WebGPU has no adapter on the test installation.
