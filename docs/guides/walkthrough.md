# A mobile-first architectural walkthrough in ~50 lines

Load a house, walk through it at eye height on a phone or a desktop, and lift the roof off into an orbit
"dollhouse" view and back. No physics engine and no WebAssembly: `WalkControls` (`@margoengine/controls/walk`)
collides against the same CPU triangle trees the `@margoengine/bvh` Raycaster uses.

<!-- Every ```ts block in this file is type-checked against the built packages by tests/from-threejs-snippets.test.js. -->

## The page

```html
<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
  canvas { display: block; width: 100vw; height: 100dvh; user-select: none; -webkit-user-select: none; }
  #view { position: fixed; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); font: 16px system-ui; padding: 12px 18px; }
  #hint { position: fixed; left: 0; right: 0; top: 16px; text-align: center; color: #fff; font: 15px system-ui; pointer-events: none; }
</style>
<canvas></canvas><button id="view">Dollhouse</button><p id="hint"></p>
<script type="module" src="./main.ts"></script>
```

## The script

```ts
import {Engine} from '@margoengine/core';
import {applyQualityTier, paceEngine, watchQuality} from '@margoengine/quality';
import {loadGLTF} from '@margoengine/gltf-pro';
import {computePrimitiveBVHAsync} from '@margoengine/bvh';
import {CameraProjection} from '@margoengine/cameras';
import {WalkControls} from '@margoengine/controls/walk';

applyQualityTier();                                    // phone, light or high tier; before the engine exists
const canvas = document.querySelector('canvas')!;
// Start on the deck, eye 1.65 m above it (y = 0), looking at the front door.
const engine = await Engine.create(canvas, {camera: {position: [2.5, 1.65, -2], target: [2.5, 1.65, 0]}});
paceEngine(engine);

const house = await loadGLTF(engine, '/assets/house.glb');
// Build the collision trees in a worker, so the first steps into a big room never stall.
await Promise.all(house.primitives.map(primitive => computePrimitiveBVHAsync(primitive)));

const projection = CameraProjection.attach(engine, {mode: 'perspective'}); // the dollhouse turns orthographic
const walk = WalkControls.attach(engine, {colliders: [house], projection});
walk.dollhouseBounds = house.bounds;                   // frame the house, not the garden around it
walk.speed = 1.4;                                      // m/s; Shift or the gamepad's left stick button runs

const button = document.querySelector<HTMLButtonElement>('#view')!;
button.onclick = () => walk.toggleDollhouse();
walk.addEventListener('mode', () => {button.textContent = walk.mode === 'walk' ? 'Dollhouse' : 'Walk';});

const hint = document.querySelector<HTMLElement>('#hint')!;
hint.textContent = matchMedia('(pointer: coarse)').matches ? 'Left thumb walks, right thumb looks' : 'Click to look, WASD to walk';
canvas.addEventListener('pointerdown', () => hint.remove(), {once: true});

engine.start();
watchQuality();
```

## What you get

- **Eye height held by the floor.** Nine vertical rays (the centre and a ring at 0.9 × the 0.25 m radius) find the
  highest walkable floor within `stepHeight` (0.19 m): hardwood, a 12 mm rug and a deck with 1 cm gaps all keep the eye
  1.65 m above the surface, and a gap narrower than about 0.41 m (1.66 × the radius, in any direction) is stepped over instead of fallen into.
- **Stairs and steps.** Risers up to 0.19 m are climbed and the eye eases up and down them (no jumps of more than
  6 cm per frame in the tests); a taller step stops you. Floors steeper than `maxSlope` (45°) are not walkable.
- **Walls, counters and glass.** A capsule from the step height to the top of the head slides along walls and around
  door jambs, and blocks at counters. It moves in sub-steps of at most half its radius, so even a single-quad glass
  pane is never crossed (tested at 30 m/s and 10 frames per second).
- **Input.** WASD or arrows (Shift runs, C crouches); click for pointer-lock mouse look, or drag; a gamepad's sticks;
  on touch screens the left half of the canvas is a floating thumbstick (drawn where the thumb lands) and the right
  half drag-looks. Speed eases in and out (`acceleration`). For anything else (an `@margoengine/input` action, a
  custom on-screen stick) write to `walk.axes` each frame.
- **Dollhouse.** `toggleDollhouse()` eases the camera out to an orbit view of `dollhouseBounds` (or of every collider)
  facing the way you were looking, hands the canvas to `walk.orbit` (an `OrbitControls`), and eases back to exactly
  where you stood. With a `CameraProjection` the dollhouse is orthographic.
- **Large sites.** With a `FloatingOrigin` from `@margoengine/cameras/origin`, pass it as `origin` so the saved walk
  pose follows a rebase: `WalkControls.attach(engine, {origin})`.
- **Games.** `walk.jumpSpeed = 4` enables Space (gamepad A) jumps under `gravity`; ceilings stop the head.

## Cost

Measured, not estimated (records in `examples/package-benchmarks/results/`):

- **Bytes.** `walk-size.json`: WalkControls, including the OrbitControls it uses for the dollhouse, is about 12 kB
  min+gzip, about 22 kB when the app does not already ship `@margoengine/bvh`. `@margoengine/physics` plus Rapier
  (`@dimforge/rapier3d-compat` 0.21.0, Wasm inlined) is about 1.65 MB gzip (4.3 MB raw); Rapier's Wasm alone is 3.1 MB
  raw. Rapier stays the upgrade path for rigid bodies, joints and vehicles.
- **CPU.** `walk-cpu.json` (`node examples/package-benchmarks/walk-cpu.mjs`; Node, one thread, a laptop with other
  work running, so read it as an order of magnitude): `update()` takes a median of 0.01-0.03 ms and at most 0.9 ms a
  frame on the generated two-storey house, a block of 16 such houses (912 meshes) and the 2.45-million-triangle
  conveyor GLB once their trees exist. The first visit to a big part builds its tree on that frame (up to 57 ms on the
  conveyor); the worker build above avoids that.

## Limits

- The dollhouse orbits the whole model, roof included; hide the roof meshes (`mesh.visible = false`) for a cutaway.
  Hidden meshes do not collide.
- Static levels: colliders are read from the last rendered frame's matrices, so a moving door collides one frame late,
  and a platform that moves does not carry the walker.
- The capsule's sides are tested exactly against triangles; floors come from the nine rays, so on a slope the eye can
  sit up to 0.9 × radius × the slope's tangent higher (2 cm on a 1:12 ramp), and a ledge holds you until the whole
  ring is past it.
- Skinned and morphed glTF meshes collide in their bind pose (as the Raycaster hits them); alpha-masked foliage and
  transparent glass collide like solid triangles.
- A primitive's tree is built on the first frame the walker comes near it; with a big model that first frame can take
  tens of milliseconds, which `computePrimitiveBVHAsync` (above) moves to a worker.
