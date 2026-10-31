# @margoengine/physics2d

Import `margoengine/physics2d` from the `margoengine` package, or `@margoengine/physics2d` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

2D rigid-body physics for Margo Engine on [Rapier](https://rapier.rs): a fixed-step engine plugin with interpolation, bodies that drive sprites, box, circle, capsule and polygon colliders, joints, scene queries, collision events, a character controller and tile map colliders in one call. Rapier is not bundled: you install `@dimforge/rapier2d-compat` (Apache-2.0) yourself and pass the initialized module in.

World units are sprite pixels, y points down and angles are radians, clockwise on screen. `pixelsPerMeter` (default 32) maps them to Rapier's metres, so a 16 pixel tile is half a metre. Mass, density, force and impulse use Rapier's units.

```ts
import RAPIER from '@dimforge/rapier2d-compat';
import {Physics2D} from 'margoengine/physics2d';

await RAPIER.init();
const physics = new Physics2D(null, {rapier: RAPIER}); // or new Physics2D(engine, ...) to step with the engine

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

It exports `Physics2D`, `Body2D`, `Joint2D`, `CharacterController2D` and `interactionGroups`. `addTileMap` accepts a `TileMapData` from `@margoengine/tilemap`, or any object of the `TileMapSource` shape. Whole-cell solid tiles merge into outline loops so bodies slide across tile seams without catching; other collision shapes (rectangles, ellipses, polygons, polylines), tile flips and layer offsets are kept. Very fast bodies on a tile map need `ccd: true`, because outlines have no thickness.

Queries (`raycast`, `overlapPoint`, `overlapShape`, `castShape`) see every collider added or moved since the last step: they bring Rapier's broad phase up to date with a zero-length step first, which moves nothing and raises no events.

Apache-2.0. Optional, tree-shakable package; core peer: ^1.0.0, Rapier peer optional.

Build and unit tests: npm test --workspace @margoengine/physics2d
