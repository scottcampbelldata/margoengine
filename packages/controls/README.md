# @margoengine/controls

Orbit, map, trackball, arcball, fly, first-person, pointer-lock and collision-aware walkthrough (/walk) camera controls, a transform gizmo and drag controls for Margo Engine.

Import `margoengine/controls` from the `margoengine` package, or `@margoengine/controls` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

`stepLocomotion(state, actions, delta, height, options?)` provides ground-following
character movement with normalized diagonals, damped speed and heading, and a
50 ms movement-step limit. Retained state is `[x,y,z,heading,cameraYaw,cameraPitch,
gaitPhase,speed]`; actions are `[strafe,forward,lookX,lookY,sprint]`.
Options include `bounds: [minX,maxX,minZ,maxZ]`, `minHeight`, `walkSpeed` (3.4),
and `runSpeed` (7). Bounds and minimum height are omitted by default. Look values
are angular deltas; pitch stays between -1.4 (look up) and 0.9 radians (look down).
Use `Cinematic` ground clearance to keep upward-looking cameras above terrain. Height samples must
be finite. The caller owns input bindings, character meshes and gait animation.

```ts
import {stepLocomotion} from 'margoengine/controls';

const state = new Float32Array(8);                    // x, y, z, heading, cameraYaw, cameraPitch, gaitPhase, speed
const actions = new Float32Array([0, 1, 0, 0, 0]);    // strafe, forward, lookX, lookY, sprint: walk forward
const ground = (x: number, z: number) => 0.1 * Math.sin(x) * Math.cos(z); // any finite height sampler
for (let frame = 0; frame < 60; frame++) stepLocomotion(state, actions, 1 / 60, ground, {bounds: [-50, 50, -50, 50]});
console.log(state[0], state[2]);                      // where the walker is after one second
```

Bad inputs throw a `RangeError` that says what to pass (finite numbers, bounds with min below max).

Orbit, map, trackball, arcball, fly, first-person and pointer-lock camera controls plus an interactive transform gizmo and drag controls for Margo Engine, each tree-shakable on its own. `DragControls` uses `@margoengine/bvh` (a peer dependency) for its hits.

Build from source with `npm run build` in `packages/controls`.

```ts
import {Engine, box} from 'margoengine/core';
import {OrbitControls, TransformControls} from 'margoengine/controls';

const canvas = document.createElement('canvas');
const engine = await Engine.create(canvas);
const mesh = engine.createMesh().setGeometry(box());

// Passing the engine attaches to engine.canvas and updates before every render.
const orbit = OrbitControls.attach(engine);
orbit.enableDamping = true;

const gizmo = TransformControls.attach(engine, {mode: 'translate', translationSnap: 0.25});
gizmo.attach(mesh);
gizmo.addEventListener('dragging-changed', event => {orbit.enabled = !event.value;});
addEventListener('keydown', event => {if (event.key === 'r') gizmo.setMode('rotate');});

engine.start();

// On teardown (engine.dispose() also disposes both):
gizmo.dispose(); orbit.dispose();
```

Drag core meshes and gltf/pbr models (a model moves by its `root`), with the mouse or touch:

```ts
import {Engine, box} from 'margoengine/core';
import {DragControls, OrbitControls} from 'margoengine/controls';
import {loadGLTF} from 'margoengine/gltf/pbr';

const engine = await Engine.create(document.querySelector('canvas')!);
const mesh = engine.createMesh().setGeometry(box());
const part = await loadGLTF(engine, '/part.glb');
const drag = DragControls.attach(engine, [mesh, part]);          // created before OrbitControls: a grab stops the orbit drag
const orbit = OrbitControls.attach(engine);
drag.plane = [0, 1, 0];                                        // slide on the ground; default 'view' faces the camera
drag.axis = [1, 0, 0];                                         // or only along world X
drag.addEventListener('dragstart', event => console.log(event.object, event.hit)); // hit: a bvh RaycasterHit
drag.addEventListener('hoveron', () => {engine.canvas.style.cursor = 'grab';});
drag.addEventListener('hoveroff', () => {engine.canvas.style.cursor = '';});
```

Turn by dragging, carry a set together, and reach into a hierarchy:

```ts
import {Engine, box} from 'margoengine/core';
import {DragControls} from 'margoengine/controls/drag';

const engine = await Engine.create(document.querySelector('canvas')!);
const table = engine.createMesh().setGeometry(box());
engine.createMesh().setGeometry(box()).setParent(table).setPosition([0.4, -0.5, 0.4]); // a leg
const chair = engine.createMesh().setGeometry(box()).setPosition([2, 0, 0]);
const stool = engine.createMesh().setGeometry(box()).setPosition([3, 0, 0]);

const drag = DragControls.attach(engine, [table, chair, stool], {transformGroup: true}); // a hit on the leg drags the table
drag.group = [chair, stool];                  // grabbing either carries both
drag.mode = 'rotate';                         // default 'translate'
drag.axis = [0, 1, 0];                        // turn about world Y; with no axis the drag turns it like a trackball
drag.rotateSpeed = 0.02;                      // radians per CSS pixel, default 0.01
addEventListener('keydown', event => {if (event.key === 'g') drag.mode = 'translate';});
```

With `mode: 'rotate'` the object turns about its own origin, or the whole `group` about the grabbed object's origin, in
world space under any parent. With an `axis` the side nearest the camera follows the pointer: a drag right turns it
right about an axis that points up on screen, and a drag down turns it down about one that points right. `recursive: true` grabs children of listed core meshes and drags the child itself;
`transformGroup: true` grabs through them and drags the listed mesh. Only grabbing a member starts a group drag, and a
member disposed during the drag is left behind.

## Walkthroughs and simple games: `@margoengine/controls/walk`

`WalkControls` is a Wasm-free kinematic first-person walker: eye height held above the floor, stairs, slopes, walls,
glass, jump and crouch, keyboard + mouse, gamepad and touch, and an orbit "dollhouse" view and back. It collides on the
CPU against the cached triangle trees of the `@margoengine/bvh` Raycaster (core meshes, gltf/pbr and materials models),
so it costs nothing unless you import its entry. A whole recipe: [docs/guides/walkthrough.md](../../docs/guides/walkthrough.md).

```ts
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {WalkControls} from 'margoengine/controls/walk';

const engine = await Engine.create(document.querySelector('canvas')!, {camera: {position: [0, 1.65, 0], target: [0, 1.65, 1]}});
const house = await loadGLTF(engine, '/house.glb');
const walk = WalkControls.attach(engine, {colliders: [house]}); // default colliders: every visible mesh and model
walk.eyeHeight = 1.7; walk.jumpSpeed = 4;                        // games: Space jumps (off by default)
document.querySelector('#view')!.addEventListener('click', () => walk.toggleDollhouse());
engine.start();
```

- **Floor.** Nine vertical rays per sub-step (the centre and a ring at 0.9 × `radius`) find the highest walkable floor
  within `stepHeight` of the feet, in one tree pass per collider. The eye eases over the change (no teleport). Floors
  steeper than `maxSlope` are ignored; beyond `stepHeight` below, the walker falls under `gravity` and lands only on
  floors it crosses. Each step integrates the fall exactly (top speed 50 m/s), so a jump peaks at v²/2g at any frame rate. Gaps narrower than about 1.66 × the radius (0.41 m by default, in any direction) are stepped over.
- **Walls.** A capsule from `stepHeight` to the top of the head (eye + 0.1 m) is pushed horizontally out of every
  triangle it overlaps (exact segment-triangle closest points, up to four passes), so it slides along walls and around
  corners. Movement is split into sub-steps of at most half the radius, so a zero-thickness pane is never crossed.
- **Input.** WASD/arrows, Shift runs, C crouches (stands up only where there is headroom), Space jumps when
  `jumpSpeed` > 0; a click locks the pointer for mouse look (`pointerLock = false` to drag-look instead); the first
  connected gamepad (left stick walks, right stick looks, A jumps, B crouches, left stick button runs); on touch, the
  left half of the element is a floating thumbstick and the right half drag-looks. `walk.axes` (stick convention) adds
  any other analog source, for example `@margoengine/input` actions.
- **Dollhouse.** `setMode('dollhouse')` / `toggleDollhouse()` eases (`transitionTime`) to an orbit view of
  `dollhouseBounds` or of the colliders, from `dollhouseElevation` above the horizon and facing the walk heading, and
  enables `walk.orbit` (an `OrbitControls`); `'walk'` eases back to the saved pose. Yaw, pitch and distance are
  interpolated, so the view never passes through vertical. With `projection` (a `CameraProjection`) the dollhouse is
  orthographic; with `origin` (a `FloatingOrigin`) the saved pose follows rebases. Events: `change`, `mode`, `lock`,
  `unlock`.
- **Work per frame** is in `walk.stats` (sub-steps, rays, collider candidates, triangles tested). Sizes and CPU cost are
  measured in [walk-size.json](../../examples/package-benchmarks/results/walk-size.json) and
  [walk-cpu.json](../../examples/package-benchmarks/results/walk-cpu.json).
- **Moving platforms.** With `carry` (the default) the walker rides what it stands on: lifts, conveyors and turntables carry its feet, a turn carries its heading, and stepping or jumping off keeps the platform's speed until the next landing. Colliders are read at this frame's transforms, at the cost of one more transform pass per update. Move a platform before the frame starts, like any mesh; `carry: false` keeps the last frame's matrices.
- **Limits.** Only the floor carries: a moving wall pushes the walker out but gives it no speed, and a tilting floor turns the heading about +Y and leaves the pitch;
  skinned meshes collide in their bind pose; on slopes the ring can hold the eye up to 0.9 × radius × the slope's
  tangent higher; a primitive's tree is built synchronously the first time the walker comes near it
  (`computePrimitiveBVHAsync` builds them in a worker beforehand). For rigid bodies, joints and vehicles use
  `@margoengine/physics`.

## Third-person camera: `@margoengine/controls/third-person`

`ThirdPersonControls` follows a mesh, a model or a position function on a spring arm. The pivot above the subject trails
it on a critically damped spring (`lag`), and each frame the arm is swept from the pivot to the camera with the
`@margoengine/bvh` Raycaster: a centre ray and four rays `probeRadius` around it, nine rays in all. When something is in
the way the arm shortens in the same frame, so a wall never sits between the camera and the subject; it lengthens over
`returnTime` once clear. The subject, its children and `ignore` never stop the arm. The app moves the subject;
`heading` is the camera's forward direction on the ground for doing that.

```ts
import {Engine, box} from 'margoengine/core';
import {ThirdPersonControls} from 'margoengine/controls/third-person';

const engine = await Engine.create(document.querySelector('canvas')!);
const hero = engine.createMesh().setGeometry(box());
const wall = engine.createMesh().setGeometry(box()).setPosition([0, 1, 3]).setScale([8, 2, 0.2]);
const follow = ThirdPersonControls.attach(engine, hero, {distance: 5, shoulder: 0.5});
follow.lag = 0.2;                        // softer follow; 0 is rigid
follow.colliders = [wall];               // default: every visible mesh and model
engine.onFrame((_, delta) => {
  const [x, , z] = follow.heading;       // walk where the camera faces
  hero.setPosition([hero.position.x + x * delta, 0, hero.position.z + z * delta]);
});
addEventListener('pointermove', event => {
  if (document.pointerLockElement) follow.rotate(-event.movementX * 0.003, event.movementY * 0.003);
});
engine.start();
```

Options and properties: `distance` (4), `minDistance` (1), `maxDistance` (12), `pivotOffset` (`[0, 1.5, 0]`), `shoulder`
(0), `yaw` and `pitch` (from the camera at attach), `minPitch` (-0.6), `maxPitch` (1.4), `rotateSpeed` (1), `zoomSpeed` (1),
`lag` (0.12 s), `returnTime` (0.25 s), `probeRadius` (0.2), `collide` (true), `colliders` (null: everything), `ignore`
(none), `raycaster` (a new one; set `layers` or `filter` on it). `armLength` reads the arm's length now, `snap()` jumps
the pivot to the subject after a teleport, and `rotate(yaw, pitch)` takes gamepads, pointer lock or
`@margoengine/input` actions. `rotate` and `update(delta)` throw a `RangeError` for a value that is not finite, and
`update` also for a negative step. Events: `start`, `change`, `end`.

### Following ships, birds and convoys

The same controls follow anything that moves, across an open world. A subject can be a mesh, a model, a position
function, or a `FollowTarget` from `@margoengine/math/fields`. That is the physics framework's follow-targets contract
([docs/physics-framework.md](../../docs/physics-framework.md), section 4): pose, velocity and acceleration at the
frame's time, in a large-world origin cell of `cellSize` metres (4096). Pass the target itself or a function returning
it each frame. Meshes and models are turned into the same pose, velocity and acceleration from their motion, smoothed
over 0.1 s. A list of subjects (a flock, a convoy) is framed together: the arm lengthens until the whole spread fits
the view.

`style` picks the follow. `'orbit'` is the default: you turn the arm. `'chase'` swings behind the travel. `'side'`
tracks alongside, on the right. `'lock'` aims `lead` (0.35) of the arm ahead, so the subject has room in front.
`'flyby'` holds a point ahead of and beside the path while the subject passes, then moves on `flybyAhead` (3) seconds
ahead. The pivot and the arm's heading each ride a critically damped spring integrated exactly (`lag` 0.12 s,
`turnLag` 0.6 s), so nothing overshoots or jitters at any frame rate. The aim leads by `lookAhead` (0.4 s outside
orbit) seconds of velocity and acceleration. `bank` (0: ships and cars stay level) is the share of a flying subject's
roll the camera banks with, within `maxBank` (0.5 rad). `ground` (a terrain query, a biomes world's `heightAt`, a
tiles height) keeps the camera `clearance` (1) above the ground. With `origin` (a `FloatingOrigin`) everything is
worked in float64 world metres and written in its local coordinates, so a ship crossing a lake hundreds of km wide
never jitters. `follow(subject, seconds)` switches what is followed and `takeOver(seconds)` eases in from the
camera's current view, for a hand-off from any other camera, or after a geospatial flight:
`geo.flyTo(view).then(() => follow.takeOver(0.8))`. `GeospatialControls.fromCamera()` hands back, keeping the pose.

```ts
import {Engine} from 'margoengine/core';
import {ThirdPersonControls} from 'margoengine/controls/third-person';
import type {FollowTarget} from 'margoengine/math/fields';

const engine = await Engine.create(document.querySelector('canvas')!);
// A freighter on Lake Michigan, as the physics world publishes it: 6 m/s east, in cell (100, 0, 0) of 4,096 m.
let time = 0;
const ship = (): FollowTarget => ({
  id: 'freighter', solver: 'boats', cell: [100, 0, 0], position: [6 * time, 0, 0],
  rotation: [0, 0, 0, 1], velocity: [6, 0, 0], acceleration: [0, 0, 0], angularVelocity: [0, 0, 0],
});
const follow = ThirdPersonControls.attach(engine, ship, {style: 'chase', distance: 120, pivotOffset: [0, 20, 0], collide: false});
engine.onFrame((_, delta) => (time += delta));
follow.style = 'flyby'; // hold a point by the shipping lane while it passes
follow.bank = 0;        // a ship stays level; a bird would take bank: 1
engine.start();
```

Sources: Halper, Helbing and Strothotte, "A camera engine for computer games: managing the trade-off between
constraint satisfaction and frame coherence", Computer Graphics Forum 20 (3), 2001, https://doi.org/10.1111/1467-8659.00514
(look-ahead and frame-coherent follow); Lino and Christie, "Intuitive and efficient camera control with the toric
space", ACM TOG 34 (4), 2015, https://doi.org/10.1145/2766965 (framing one or two subjects, lead room); Gleicher and
Witkin, "Through-the-lens camera control", SIGGRAPH 1992, https://doi.org/10.1145/133994.134088 (aim from screen
goals); the critically damped spring is the damped harmonic oscillator at damping ratio 1, x(t) = (x0 + (v0 +
w x0) t) e^(-w t), stepped with that closed form so the result does not depend on the frame rate. Limits: `docs/limits.md`, "Follow camera".

Without an engine, pass a `Camera` and an element and drive the controls yourself: `const fly = new FlyControls(camera, canvas); engine.onFrame((_, delta) => fly.update(delta));`.

`OrbitControls.update()` reuses its camera vectors during continuous updates. Copy `camera.position` and `camera.target` when taking a snapshot.

Unbound mouse buttons and disabled mouse actions leave existing pointer capture untouched, including on pointer-up,
cancellation and disposal. Orbit captures a mouse pointer only after selecting a supported drag; handled mouse/touch
gestures release their captures when they end, are cancelled or the controls disconnect. A touch is captured
when a one- or two-touch gesture is enabled, so the first finger of a pinch is held even when one-touch input is unbound.

An exact top/bottom view stays exact during idle updates, panning and dollying when `camera.up` is nonparallel to the
view direction (for example `[0,0,-1]` above the target). Polar/distance limits still apply. The default parallel `+Y`
up direction and angular motion retain the small pole safety gap; rotating away keeps the heading from `camera.up`.

## Controls

| Class | Input |
| --- | --- |
| `OrbitControls` | Left drag rotates, middle drag or wheel dollies, right drag (or shift/ctrl + left) pans, arrows pan after `listenToKeyEvents(target)`. One finger rotates, two fingers dolly and pan. |
| `MapControls` | Left drag pans along the ground, right drag rotates, two fingers dolly and rotate. |
| `TrackballControls` (`/trackball`) | Left rotates freely, middle zooms, right pans; hold A, S or D to switch the left button (only releasing that same key switches it back). Coasts with `dynamicDampingFactor` once the button is released; while the button is held still the view stays put and the fling fades. Two fingers down and up again are one `start` and one `end`. Without `enableRoll` a drag stops just short of a pole only when it would reach it; one that passes close by carries on. With `enableRoll`, a drag near the edge rolls and the view passes over the poles. |
| `ArcballControls` (`/arcball`) | Left drag turns freely on Shoemake's arcball (rolls, passes over the poles), right drag or Shift + left pans, middle drag, the wheel and a pinch zoom toward the cursor. One finger rotates, two fingers pinch and pan. |
| `FlyControls` (`/fly`) | WASD moves, R/F up and down, arrows yaw and pitch, pointer offset from center steers (or `dragToLook`). With `enableRoll`, Q and E roll. |
| `FirstPersonControls` (`/first-person`) | Pointer offset from center turns, WASD or arrows move, R/F up and down, left/right button walks. |
| `PointerLockControls` | `lock()` from a click, mouse look while locked, WASD/arrows/R/F through `update(delta)`, plus `moveForward`, `moveRight`, `moveUp`. |
| `TransformControls` | Translate (axis arrows, plane squares, center screen-plane handle), rotate (axis rings, view ring, free trackball disc), scale (axis handles, uniform center). |
| `WalkControls` (`/walk`) | WASD/arrows, mouse look (pointer lock or drag), gamepad sticks, touch thumbstick + drag-look; collides with the scene, holds eye height, climbs stairs. |
| `ThirdPersonControls` (`/third-person`) | Follows a subject on a spring arm that pulls in at walls. Drag or one finger turns the view, the wheel or a pinch changes the distance. |
| `DragControls` | Left button or one finger grabs the nearest listed core mesh or gltf/pbr model and moves it on the view plane, a world plane (`plane`) or a world axis (`axis`), or turns it with `mode: 'rotate'`. Mouse hover reports the object under the pointer. |

Every control has `enabled`, `connect(element)`, `disconnect()`, `update(delta)` (returns true when the camera moved), `dispose()` and `addEventListener`. Script motion is checked before it changes anything: `OrbitControls` and `ArcballControls` `rotateLeft`, `rotateUp`, `rotate`, `pan`, `dollyIn` and `dollyOut`, `FirstPersonControls` `lookAt` and `update`, `TrackballControls` `update` (also for a negative step), and `ThirdPersonControls` `rotate` and `update` (also for a negative step), throw a `RangeError` for a value that is not finite or a dolly factor that is not above 0, so one NaN cannot leave the camera at NaN. Camera controls emit `change`, and the drag-based ones `start` and `end`. `PointerLockControls` emits `lock` and `unlock`. `TransformControls` emits `change`, `mouseDown`, `mouseUp`, `objectChange`, `dragging-changed` (`value`), `axis-changed` (`value`), `mode-changed`, `space-changed` and `pivot-changed` (`value`). `DragControls` emits `dragstart` (`object`, `hit`), `drag`, `dragend`, `hoveron` and `hoveroff` (each with `object`).

`DragControls` casts the pointer ray with a bvh `Raycaster` (`setFromEngine`, then `intersectObjects` on its `objects`), so it follows layers, `filter` and material sides, and works with orthographic cameras from @margoengine/cameras, whose rays start on the near plane. The drag plane passes through the grabbed point; with `axis` it contains the axis and faces the camera as far as it can. Each move intersects the new pointer ray with that plane and sets the object's position in its parent's space, so parented meshes follow the pointer. A grab stops later pointer-down listeners on the element and captures the pointer; touch uses the primary pointer and ignores other fingers. Pass your own `raycaster` to share layers and filters.

The root exports every control. An app that uses a few imports their entries instead, so the others stay out of its
module graph: `@margoengine/controls/orbit` (`OrbitControls`, `MapControls`, `MOUSE`, `TOUCH`, the `Controls` base),
`@margoengine/controls/arcball` (`ArcballControls`, `arcballPoint`, the `Controls` base),
`@margoengine/controls/fly` and `@margoengine/controls/trackball` (`FlyControls` and `TrackballControls`, each with the
`Controls` base),
`@margoengine/controls/transform` (`TransformControls` and its types), `@margoengine/controls/drag` (`DragControls`;
loads bvh), `@margoengine/controls/third-person` (`ThirdPersonControls`; loads bvh) and `@margoengine/controls/profiles` (the navigation profiles). They are the same classes as the root's.

## Arcball: `@margoengine/controls/arcball`

`ArcballControls` turns the camera around `camera.target` with no fixed up axis. Each pointer move lifts the previous
and current points onto a virtual ball (`arcballPoint(x, y)`: the unit sphere inside radius 1/sqrt(2) of the smaller
half-size of the element, the hyperbolic sheet `z = 1 / (2r)` outside it, continuous where they meet) and turns the view
by the angle between them about their cross product, so the camera rolls and passes over the poles; it writes
`camera.up`. That is the single angle of Bell's trackball: Shoemake's original arcball turns by twice the angle, so a
drag across the ball turns about half as far here (raise `rotateSpeed` to 2 for Shoemake's rate). Pan moves the target
and camera together and keeps the grabbed point under the pointer; zoom scales the view about the point under the cursor
on the plane through the target, within `minDistance` and `maxDistance`. Under a fixed-size orthographic
`CameraProjection` the zoom changes `projection.zoom` instead (within `minZoom` and `maxZoom`), still about the cursor.
With `enableDamping`, rotation, pan and zoom ease out after release (a fling keeps spinning and slows to rest).

An update with no pending motion returns `false` without rebuilding the camera basis when the distance is within
the live limits. Changing `minDistance` or `maxDistance` still takes effect on the next update. Immediate pointer
updates and a following frame update can both be used; the latter does no camera work when the motion is consumed.

```ts
import {Camera} from '@margoengine/core';
import {ArcballControls} from '@margoengine/controls/arcball';

const canvas = document.createElement('canvas');
document.body.append(canvas);
const camera = new Camera({position: [0, 0, 10], target: [0, 0, 0]});
const controls = new ArcballControls(camera, canvas);
console.assert(controls.update() === false);
controls.maxDistance = 5;
console.assert(controls.update() === true); // applies a live limit even without input
controls.dispose();
canvas.remove();
```

```ts
import {Engine, box} from 'margoengine/core';
import {CameraProjection} from 'margoengine/cameras';
import {ArcballControls} from 'margoengine/controls/arcball';

const engine = await Engine.create(document.querySelector('canvas')!);
engine.createMesh().setGeometry(box());
CameraProjection.attach(engine, {mode: 'orthographic', height: 6}); // optional: the arcball zooms its `zoom`
const arcball = ArcballControls.attach(engine);
arcball.enableDamping = true;
arcball.minDistance = 1;
arcball.maxDistance = 50;
arcball.enablePan = false;                                           // enableRotate, enableZoom, enablePan per gesture
arcball.saveState();
arcball.addEventListener('change', () => console.log(engine.camera.up));
addEventListener('keydown', event => {if (event.key === 'Home') arcball.reset();});
engine.start();
```

Programmatic motion: `rotate(axis, angle)` (world axis through the target), `pan(dx, dy)` in CSS pixels, `dollyIn` and
`dollyOut`. Pass `{projection}` as the third constructor argument to name the projection when the camera is not an
engine's. A `CameraProjection` answers `camera.up` with its own `up` for an exactly vertical view, so a roll is not kept
at that one orientation.

## Roll: `@margoengine/controls/fly` and `@margoengine/controls/trackball`

Both keep the horizon level until you ask for roll. With `enableRoll`, `FlyControls` flies like an aircraft: Q rolls left,
E rolls right at `rollSpeed`, yaw and pitch turn about the camera's own axes, and looping over the top works. W follows
the view and R and F follow the rolled screen up. `TrackballControls` applies the whole ball rotation, so a drag near the
edge of the element rolls the view, and a drag through the top carries the eye over the pole. Both write `camera.up` and
keep it at right angles to the view. Turning `enableRoll` off leaves `camera.up` where it was; `camera.up = [0, 1, 0]`
levels the horizon (with the view off the vertical, which core refuses as parallel to `up`).

```ts
import {Engine, box} from 'margoengine/core';
import {FlyControls} from 'margoengine/controls/fly';
import {TrackballControls} from 'margoengine/controls/trackball';

const engine = await Engine.create(document.querySelector('canvas')!);
engine.createMesh().setGeometry(box());

const flight = FlyControls.attach(engine);
flight.enableRoll = true;
flight.rollSpeed = 1;                                                // radians per second
flight.dragToLook = true;

// Or inspect freely instead:
flight.dispose();
const ball = TrackballControls.attach(engine);
ball.enableRoll = true;
ball.saveState();
addEventListener('keydown', event => {if (event.key === 'Home') ball.reset();}); // also restores camera.up
engine.start();
```

## Keep the target in bounds, snap and shortcuts

```ts
import {Engine, box} from 'margoengine/core';
import {OrbitControls, TransformControls} from 'margoengine/controls';

const engine = await Engine.create(document.querySelector('canvas')!);
const mesh = engine.createMesh().setGeometry(box());

const orbit = OrbitControls.attach(engine);
orbit.zoomToCursor = true;                                       // dolly toward the point under the pointer
orbit.targetBounds = {min: [-5, 0, -5], max: [5, 3, 5]};         // panning cannot leave this box

const gizmo = TransformControls.attach(engine, {mode: 'scale'}); // axis, plane (XY, YZ, XZ) and uniform handles
gizmo.attach(mesh);
gizmo.listenToKeyEvents(window);                                 // W/E/R modes, Q space, + / - size, Escape cancels a drag
gizmo.addEventListener('dragging-changed', event => {orbit.enabled = !event.value;});
gizmo.rotationSnap = Math.PI / 12;                               // also snaps the free rotation disc
// Holding Ctrl while dragging snaps to gizmo.heldSnap (0.25 m, 15 degrees, 0.1 scale) when no snap is set.
```

## Move, rotate and scale at once

`mode: 'all'` draws every handle together, like the all-in-one transform tools of DCC apps and editors: the move arrows,
plane squares and centre, the rotation rings `RX`, `RY` and `RZ`, and scale cubes `SX`, `SY` and `SZ` just past the arrow
tips. Every handle has its own name, so `gizmo.axis` and `axis-changed` say which one is hovered. With one object the
scale cubes follow its own axes even in world space, as in the `scale` mode. W/E/R still switch to the single modes.

```ts
import {Engine, box} from 'margoengine/core';
import {TransformControls} from 'margoengine/controls';

const engine = await Engine.create(document.querySelector('canvas')!);
const gizmo = TransformControls.attach(engine, {mode: 'all', space: 'local'});
gizmo.attach(engine.createMesh().setGeometry(box()));
gizmo.addEventListener('axis-changed', event => console.log('hovering', event.value)); // 'X', 'RY', 'SZ', ...
```

## Gizmo arrows, drag lines and occlusion

With `flipAxes`, move and scale handles point to the camera's side of each axis, so an arrow never hides behind the
object it moves. They flip once an axis faces away from the camera by more than a small margin, and hold still during a
drag; a drag moves the same way whichever way its arrow points. During a drag the gizmo draws what the drag has done so far: a line from the
start (with a small marker) for a move and for an axis or plane scale, and a swept wedge from the grab point for a turn
on an axis or view ring, which follows snapping and winds past a full turn. A uniform scale and a free turn draw none.
With `occlude`, handles behind scene geometry are hidden by the scene's depth buffer instead of drawing on top, so the
part of each arrow inside the object is hidden too. Picking is on the CPU and has no scene depth, so pass `occluder` as well
to stop a hidden handle taking the pointer: it gets a ray and returns the distance to the nearest surface, or null.

```ts
import {Engine, box} from 'margoengine/core';
import {TransformControls} from 'margoengine/controls/transform';

const engine = await Engine.create(document.querySelector('canvas')!);
const mesh = engine.createMesh().setGeometry(box());
const gizmo = TransformControls.attach(engine, {flipAxes: true, occlude: true});
gizmo.attach(mesh);
gizmo.showDelta = false;  // no line or wedge during a drag
engine.start();
```

## Gizmo offset, size and colours

`offset` puts the gizmo at a point of the attached object in its own space, such as a door's hinge, and moves, turns
and scales then go about that point: the object's origin orbits it. It applies with one object attached; a selection
of several uses `pivot`. `fixed: false` makes `size` the gizmo's length in world units instead of a multiplier of its
constant on-screen size. `axisColors` and `hoveredColor` take `'#rgb'`, `'#rrggbb'`, `'#rrggbbaa'` or `[r, g, b]` / `[r, g, b, a]` in
0..1, and `lineWidth` sets the width in CSS pixels of the shafts, scale lines and rings. Each is also a live property;
a bad value throws a `TypeError` or `RangeError` that names the fix and links to
[margoengine.com/errors#controls-transform](https://margoengine.com/errors#controls-transform).

```ts
import {Engine, box} from 'margoengine/core';
import {TransformControls} from 'margoengine/controls/transform';

const engine = await Engine.create(document.querySelector('canvas')!);
const door = engine.createMesh().setGeometry(box());
const gizmo = TransformControls.attach(engine, {
  mode: 'rotate',
  offset: [-0.5, 0, 0],  // the hinge edge of a 1 m box
  axisColors: ['#ff2060', '#20df80', '#2080ff'],
  hoveredColor: '#ffff40',
  lineWidth: 4,
});
gizmo.attach(door);
gizmo.fixed = false;  // size is now 1 world unit long
engine.start();
```

## Keep the target near a point, and zoom an orthographic view

`minTargetRadius` and `maxTargetRadius` hold the target inside a spherical shell around `cursor`: panning stops at the edge
and the camera moves with the target, so the view never swings. It works with `targetBounds`; the sphere is applied
last. `zoom` reads and writes a `CameraProjection`'s zoom, within `minZoom` and `maxZoom`. With `orthoZoom`, the wheel,
dolly drags and pinch change that zoom under a fixed-size orthographic projection (an explicit `height` or fixed bounds),
about the cursor with `zoomToCursor`. Without it they change only the distance there, which leaves the picture as it was.

```ts
import {Engine, box} from 'margoengine/core';
import {CameraProjection} from 'margoengine/cameras';
import {OrbitControls} from 'margoengine/controls/orbit';

const engine = await Engine.create(document.querySelector('canvas')!);
engine.createMesh().setGeometry(box());
CameraProjection.attach(engine, {mode: 'orthographic', height: 6});
const orbit = OrbitControls.attach(engine);
orbit.cursor = [0, 1, 0];
orbit.maxTargetRadius = 5;     // panning stays within 5 units of the point above
orbit.orthoZoom = true;        // the wheel zooms the fixed-height view
orbit.zoomToCursor = true;
orbit.minZoom = 0.25;
orbit.maxZoom = 8;
document.querySelector('#fit')!.addEventListener('click', () => {orbit.zoom = 1;});
engine.start();
```

## Edit several objects at once

`gizmo.attachMany(meshes, active)` puts one gizmo on several meshes. `active` (default the last one) gives the `local`
axes. `pivot` sets what they turn and scale about: `'median'` (the mean of their origins, the default), `'active'` (the
active object's origin) or `'individual'` (each about its own origin, with the gizmo at the median). `space` works as
with one object, and under `individual` with `local` each object also follows its own axes: an X drag moves each along
its own X, and an X ring turns each about its own X. A mesh whose ancestor is attached too follows that ancestor, so
nothing moves twice. Parents, snapping, `reset()` and Escape work on the whole set, and `gizmo.objects` lists it. A mesh
disposed during a drag drops out; if it was the active one, the last of the others takes over and the drag ends as a
release does: `mouseUp` and `dragging-changed` (`false`) fire and the pointer capture is let go, so an orbit turned
off for the drag comes back on.

```ts
import {Engine, box} from 'margoengine/core';
import {TransformControls} from 'margoengine/controls/transform';

const engine = await Engine.create(document.querySelector('canvas')!);
const crates = [-2, 0, 2].map(x => engine.createMesh().setGeometry(box()).setPosition([x, 0, 0]));
const gizmo = TransformControls.attach(engine, {mode: 'rotate', pivot: 'individual', space: 'local'});
gizmo.attachMany(crates, crates[1]);
addEventListener('keydown', event => {
  if (event.key === '.') gizmo.setPivot(gizmo.pivot === 'median' ? 'active' : 'median');
});
engine.start();
```

## Drive the gizmo with a ray

A pointer is not the only thing that can hold a handle. `rayHover(origin, direction)` lights the handle a world ray
points at and returns its name, `rayDown(origin, direction)` grabs it (false when the ray points at none),
`rayMove(origin, direction)` drags it and `rayUp()` lets go. The ray is an origin and a direction in world space, for
example an XR controller's target ray; `@margoengine/xr/gizmo` feeds a headset's controllers to these calls. Modes,
spaces, pivots, several objects, snapping, `cancelDrag()`, `reset()` and the events work as with a pointer.

- An arrow or scale cube follows the point of its axis nearest the ray. When the ray runs within 2.5 degrees of the
  axis that point is not steady, so the handle follows the hand's own travel along the axis instead and carries on
  from where it is when the ray turns away, with no jump.
- A plane handle follows the ray over its plane, and a ring turns by the angle the ray sweeps on the ring's plane.
- The view ring, the free turn and the centre scale handle read the ray's travel across a plane facing the ray at the
  grab.
- `scaleDown()` starts a two-point scale in any mode and `scaleTo(factor)` sizes everything attached about the gizmo
  (1 is the size at the start, the scale snap applies) until `rayUp()`.

```ts
import {Engine, box} from 'margoengine/core';
import {TransformControls} from 'margoengine/controls/transform';

const engine = await Engine.create(document.querySelector('canvas')!);
const crate = engine.createMesh().setGeometry(box());
const gizmo = TransformControls.attach(engine, {translationSnap: 0.25});
gizmo.attach(crate);
engine.render();
// A ray from a hand at [0.5, 2, 3] down to the X arrow, then swung to meet the axis one unit further along.
const hand = [0.5, 2, 3], reach = 0.6 * gizmo.frame()!.size;
const toward = (x: number) => [x - hand[0], -hand[1], -hand[2]];
if (gizmo.rayDown(hand, toward(reach))) {
  gizmo.rayMove(hand, toward(reach + 1));
  gizmo.rayUp();
}
console.log(crate.position.x); // 1
```

## Arcball gizmo, focus and keyboard

`ArcballGizmo.attach(arcball)` draws the ball the pointer drags: rings about the world axes and an outline, centred on the
target, with the far half of each ring dimmed. It shows during a gesture, or all the time with `autoHide: false`. With
`autoHide: false` a ring can be grabbed: a left drag that starts within 8 pixels of a ring's drawn near half (anywhere along
the line, and with the view rolled) turns the view about that ring's axis only, keeping the grabbed point under the pointer; a press anywhere else is the usual free turn. Touch
always turns freely. A double-click moves the view centre to the point under the pointer without changing the turn or the
distance; with no `pick`, or when `pick` returns null, that point is on the plane through the target. `focus(point)` does
the same from code. With `enableDamping` the view glides there. `listenToKeyEvents(window)` turns on the keyboard: arrows
turn the view by `keyRotateStep`, Shift + arrows pan by `keyPanStep` (the camera goes the way the arrow points), Q and E roll, + and - zoom and Home resets. Every
key is in `keys`, and each follows its `enableRotate`, `enablePan` or `enableZoom`.

```ts
import {Engine, box} from 'margoengine/core';
import {Raycaster} from 'margoengine/bvh';
import {ArcballControls, ArcballGizmo} from 'margoengine/controls/arcball';

const engine = await Engine.create(document.querySelector('canvas')!);
engine.createMesh().setGeometry(box());
const arcball = ArcballControls.attach(engine);
const gizmo = ArcballGizmo.attach(arcball, {autoHide: false});
const raycaster = new Raycaster();
arcball.pick = (x, y) => {
  const {origin, direction} = arcball.rayAt(x, y);
  raycaster.set(origin, direction);
  return raycaster.intersectEngine(engine)[0]?.point ?? null;
};
arcball.listenToKeyEvents(window);
gizmo.lineWidth = 3;
engine.start();
```

## Navigation profiles

Engineers get the mouse, wheel, touch and keys of the tool they know, in one call:

```ts
import {Engine} from 'margoengine/core';
import {OrbitControls, SOLIDWORKS} from 'margoengine/controls';
import {CameraProjection} from 'margoengine/cameras';
import {ViewCube} from 'margoengine/viewcube';

const engine = await Engine.create(document.querySelector('canvas')!);
const projection = CameraProjection.attach(engine, {mode: 'perspective'});
const orbit = OrbitControls.attach(engine).setProfile(SOLIDWORKS);
orbit.listenToKeyEvents(window);                                       // profile keys (F, Ctrl+1..7) and arrows
orbit.addEventListener('fit', () => projection.fit([-1, -1, -1, 1, 1, 1])); // double middle click or F: your bounds
ViewCube.attach(engine, {...SOLIDWORKS.viewCube});                     // a repeated face click flips to the opposite view
```

A profile is plain data (`NavigationProfile`): a `drag` table keyed by modifiers + mouse button (`'shift+1'` is Shift +
middle; Meta counts as Ctrl; modifiers must match exactly), wheel direction, zoom to cursor, `touches`, an optional
double-click `fitClick` button and `keys` keyed by modifiers + `KeyboardEvent.code`. `setProfile` copies it onto the
existing OrbitControls fields (`touches`, `zoomToCursor`, and `mouseButtons` for table-less profiles) and returns the
controls, so options set afterwards (`enableDamping`, `zoomSpeed`, `zoomToCursor`) still win. `MARGO` (the default,
also what a fresh OrbitControls does) restores the default behaviour. Each profile is its own export, so an app bundles only
the one it imports (OrbitControls + one profile: +171 B gzip); `PROFILES` (all nine by name, for a preferences menu,
+427 B) is there when you want the choice at run time. Write your own the same way: `orbit.setProfile({...BLENDER,
zoomToCursor: true})`.

Why a method and data, not `attach(engine, {profile: 'solidworks'})`: `attach` mirrors the constructor (engine, element)
like every other control, a string name would pull every profile into every bundle, and `setProfile` also switches
tools at run time from a preferences menu. `fit` is an event because only the app knows what to fit (the selection, the
whole model, a CameraProjection or a perspective `camera.fitToBoundingBox`).

| Profile | Rotate | Pan | Zoom drag | Wheel (forward = away from you) | Fit | Touch (1 finger / 2) | Keys | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MARGO` (default) | Left; Ctrl/Meta/Shift + right | Right; Ctrl/Meta/Shift + left | Middle | In, toward the target | - | Rotate / pinch + pan | Arrows pan, Ctrl/Shift + arrows rotate | `OrbitControls` defaults |
| `SOLIDWORKS` | Middle | Ctrl + middle | Shift + middle | **Out**\*, at the cursor | Double middle click, F | Rotate / pinch + pan | Ctrl+1..7 front, back, left, right, top, bottom, iso\* | SOLIDWORKS Help: Middle Mouse Button, Keyboard Shortcuts; Options > View "Reverse mouse wheel zoom direction" |
| `AUTOCAD` | Shift + middle (3DORBIT) | Middle (MBUTTONPAN=1) | - | In, at the cursor (ZOOMWHEEL=0) | Double middle click (zoom extents) | **Pan**\* / pinch + pan | - | AutoCAD Help: Pan or Zoom with the Wheel Mouse, 3DORBIT |
| `INVENTOR` = `FUSION` | Shift + middle | Middle | - | In\*, at the cursor\* | Double middle click | Rotate / pinch + pan | - | Inventor Help: Navigate with the mouse; Fusion Help: Preferences > General "Pan, Zoom, Orbit shortcuts: Fusion" |
| `BLENDER` | Middle | Shift + middle | Ctrl + middle | In, to the view centre ("Zoom to Mouse Position" off) | Home, numpad . | Rotate / pinch + pan | Numpad 1/3/7 front, right, top, Ctrl + numpad for back, left, bottom; numpad 5 persp/ortho | Blender Manual: 3D Viewport > Navigation; Preferences > Navigation |
| `MAYA` | Alt + left (tumble) | Alt + middle (track) | Alt + right (dolly)\* | In, to the centre of interest | F, A | Rotate / pinch + pan | - | Maya Help: Tumble, track or dolly the camera; Frame selection / all |
| `ONSHAPE` | Right | Middle; Ctrl + right | - | **Out**\*, at the cursor | F | Rotate / pinch + pan | Shift+1..7 views\* | Onshape Help: Mouse controls, Keyboard shortcuts |
| `RHINO` | Right (perspective views); Ctrl + Shift + right | Right (parallel views); Shift + right | Ctrl + right | In, at the cursor\* | - | Rotate / pinch + pan | - | Rhino Help: Navigate in viewports, Options > View |

\* Not certain of the tool's shipped default (from memory of each tool's docs; not checked against a running copy):
SolidWorks and Onshape wheel direction (both have a reverse option; set `{...SOLIDWORKS, wheel: 1}` if yours zooms in on
forward), Inventor's wheel direction and zoom-to-cursor default, Rhino's zoom-to-cursor, Maya's dolly axis (Maya also
reads horizontal motion; here vertical drag dollies, up = in), Onshape's Shift + digit view keys, and the touch rows:
SolidWorks and Fusion use one finger to rotate and two to pan and pinch; AutoCAD's web and mobile apps pan with one
finger; Blender, Maya, Onshape and Rhino have no first-party touch defaults here, so they use the default one.
Every profile keeps the default arrow keys and `TOUCH` constants; mouse buttons a profile leaves unbound (left in most CAD
tools, which is selection) do nothing, so the app's own click handling keeps them.

Browser gesture conflicts handled: the context menu is suppressed while the controls are enabled (right drags in Onshape,
Rhino, Maya); a press that starts a gesture cancels its compatibility `mousedown` (no middle-button autoscroll or Linux
paste, no text selection); after an Alt drag (Maya) the Alt keyup is cancelled so Firefox on Windows does not open its
menu bar; Ctrl + wheel is a trackpad pinch (never inverted by `wheel: -1`) and its page zoom is prevented; only bound keys
are cancelled, so Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+9 and F5 reach the browser. Not avoidable from a page: Linux window
managers move the window on Alt + drag (Maya users there remap the window-manager key to Super, as for desktop Maya), and
browsers may keep Ctrl+1..8 for tab switching before the page sees it (SolidWorks view keys; the ViewCube still works).

Not modelled: roll (SolidWorks Alt + middle, two-finger twist), SolidWorks rotate about a clicked entity, AutoCAD
Ctrl + Shift + middle free orbit, Blender Ctrl/Shift + wheel pan and numpad 2/4/6/8 steps, Maya Alt + Ctrl box zoom,
Inventor F2-F6 (F6 focuses the browser's address bar), 3Dconnexion space mice (WebHID, not trivial), gamepads (use
`@margoengine/input`, which polls actions per tick; these profiles are event chords on the canvas). Profiles drive
`OrbitControls` and `MapControls`. The stage's `CADCameraControls` (attached by `createStage`) hard-codes left orbit,
other buttons or Shift pan, and wheel zoom; for a CAD tool's mapping, `cadControls(stage.engine, {profile: SOLIDWORKS,
keys: window})` replaces them with `OrbitControls` under that profile in one call (on a bare engine it just attaches
them), and returns the controls so you can listen for `fit`.
Under an orthographic `@margoengine/cameras` projection the wheel and dolly drags change the visible height (ortho zoom)
about the cursor when the projection's `height` is left at its default (perspective height at the target); with an
explicit `height` or all four fixed bounds they change only the distance, and zoom to cursor adds no pan, unless `orthoZoom` is on.

SolidWorks, AutoCAD, Inventor, Fusion, Blender, Maya, Onshape and Rhino are trademarks of their respective owners. They
are named here only to say whose mouse mapping a profile follows; Margo Engine is not affiliated with or endorsed by
any of them.

## Interruptible camera transitions

Import `OrbitControls`, `MapControls`, `ArcballControls` or `TrackballControls` from
`@margoengine/controls/transitions` to add `controls.transitions`. Their existing
input, engine update, saved state and disposal APIs stay available. The root entry
does not load transitions. With an engine, moves advance before rendering; with a
bare camera, call `update(deltaSeconds)` yourself:

```ts
import {Camera} from '@margoengine/core';
import {OrbitControls} from '@margoengine/controls/transitions';

const camera = new Camera({position: [0, 2, 10], target: [0, 0, 0]});
using controls = new OrbitControls(camera);
const completed = controls.transitions.setLookAt([8, 3, -4], [1, 0, 0], {duration: 0.6});
for (let frame = 0; frame < 60; frame++) controls.update(1 / 60);
console.log(await completed); // true; input, replacement, abort or disposal resolves false

await controls.transitions.setTarget([0, 0, 0], {duration: 0});
await controls.transitions.fitToBox({min: [-2, -1, -3], max: [2, 1, 3]}, {aspect: 16 / 9, duration: 0});
await controls.transitions.fitToSphere({centre: [0, 0, 0], radius: 3}, {aspect: 16 / 9, duration: 0});
```

All four methods return `Promise<boolean>`. Options: `duration` (0.6 seconds),
`easing` (quintic smoothstep with zero endpoint velocity and acceleration),
`signal` (none), and `up` (current up for arcball and rolling trackball, world +Y
otherwise). Fits also take `padding` (0.05 of each dimension on each side) and
`aspect` (element width/height, or 1 without an element). `active` reports motion;
`cancel()` stops at the current view. Pointer, wheel and bound key input cancel
before applying their motion. Replacement, `reset()` and `dispose()` settle the
old promise and detach its abort listener. Invalid requests throw without
interrupting a valid move; an already aborted signal resolves false immediately.

Eye distance and orthographic zoom interpolate geometrically; target translation
uses the eased parameter. World-up controls interpolate azimuth and polar angle;
arcball and rolling trackball use quaternion interpolation, preserving roll and
avoiding a zero-length view on an opposite-side move. Existing damping/coast is
cleared without changing the saved reset state. External camera or zoom changes
cancel on the next update. An engine pause also pauses the move.

Fits retain the view direction, contain every box corner or the full sphere
silhouette, and check the near/far planes. Orthographic fits need an attached
`@margoengine/cameras` projection and an updated camera matrix. Assign it to
`controls.projection` for orbit/map/trackball; pass `{projection}` as the third
constructor argument for arcball. Distance, polar, azimuth, target box/shell and
zoom limits are respected; an unreachable fit or a straight target path through
the minimum target radius throws instead of clipping silently. Custom perspective
projections are not accepted by the fit methods. Moving bounds are sampled when
called; subsequent scene motion does not retarget the move.

## Orbit behaviours: `@margoengine/controls/behaviors`

`OrbitBehaviors` adds three behaviours to an `OrbitControls` from `/transitions`; each is off until you ask for it.
Call `behaviors.update(delta)` right before `controls.update(delta)` each frame.

- **Elastic bounce** (`bounce`): the control's `minDistance` and `maxDistance` become the soft limits. The hard limits
  widen by `overshoot` (default 0.2 of the limit), so a wheel or pinch can stretch past a soft limit, and when the
  input ends a damped spring (`stiffness` 120, `damping` 1, a ratio of 1 settling without swing) pulls the distance
  back. Pass `min` and `max` to set the soft limits yourself.
- **Idle auto-rotation** (`autoRotate`): turns the view after `wait` seconds (default 3) without input, at `speed`
  (default the control's `autoRotateSpeed`), and stops at the next input or while a transition runs. `idleTime` reports
  the wait so far.
- **Animated framing** (`frame`): `frame({min, max})` or `frame({bounds})` (a model's six-number bounds) flies the
  camera to fit the box with `controls.transitions.fitToBox`; it takes the `FitOptions` of that method and resolves
  false when input cancels it.

```ts
import {Camera} from '@margoengine/core';
import {OrbitControls} from '@margoengine/controls/transitions';
import {OrbitBehaviors} from '@margoengine/controls/behaviors';

const camera = new Camera({position: [0, 2, 8], target: [0, 0, 0]});
using controls = new OrbitControls(camera);
controls.minDistance = 3;
controls.maxDistance = 12;
using behaviors = new OrbitBehaviors(controls, {bounce: true, autoRotate: {wait: 2}});
const framed = behaviors.frame({min: [-1, 0, -1], max: [1, 2, 1]}, {duration: 0.4});
for (let frame = 0; frame < 60; frame++) {
  behaviors.update(1 / 60);
  controls.update(1 / 60);
}
console.log(await framed, behaviors.idleTime);
```

The bounce is a spring, Hooke's law with viscous damping, integrated in sub-steps of at most 1/240 s so any frame
length is stable. Bad options throw a RangeError that ends with its fix, and `frame` on a control that is not from
`/transitions` throws one too. `dispose()` (or `using`) stops listening; the widened limits stay.

## How it works

- **Camera model.** The Margo Engine `Camera` is a position, a target, `fov`, `near`, `far` and an `up` vector (default world +Y). All controls write `camera.position` and `camera.target` and nothing else. `OrbitControls.target` reads and writes `camera.target`. The core camera rejects a view parallel to its `up`, so with the default +Y every control keeps the view at least a hair off the poles (orbit uses an epsilon on the polar angle, the walk controls cap pitch just under 90 degrees).
- **Roll.** `ArcballControls` rolls freely, and `FlyControls` and `TrackballControls` roll with `enableRoll`; each of these then drives `camera.up`. The others keep world +Y up and do not roll (on an exact pole, such as a ViewCube top view, OrbitControls reads its heading from `camera.up`). By default `TrackballControls` computes its rotation axis from the rendered frame (screen right and up derived from +Y), drops any roll of `camera.up`, and stops the eye just short of a pole instead of tumbling over it, and `FlyControls` ignores Q and E and yaws around world +Y.
- **Damping.** The factors are applied per 1/60 s (`1 - (1 - factor)^(delta * 60)`), so 30 and 60 fps settle identically. Without damping, pointer input is applied immediately.
- **Zoom to cursor.** The dolly is a scaling about the point under the cursor on the plane through the target facing the camera, so the view direction is unchanged and that point keeps its pixel exactly. A fixed-size orthographic projection keeps its target instead, since its visible size does not change.
- **Engine integration.** Constructed with an engine, a control registers a small plugin whose `onPreUpdate` calls `update(delta)` before each render, and `engine.dispose()` disposes it. Rendering manually with `engine.render()` passes `delta = 0`, which still applies direct input but does not advance damping, auto-rotate or key movement; pass `{delta}` to advance them.
- **Listeners.** Pointer listeners go on the canvas (or the element you pass), using pointer capture. Keyboard listeners for the trackball, fly, first-person and pointer-lock controls go on the element's `ownerDocument` unless you pass `{keyTarget}`. A key held when the window loses focus sends no keyup, so `WalkControls` and `TrackballControls` also listen for the window's `blur` and let go of held keys and key modes then. Nothing is touched at import time and construction only touches the element you give it, so modules are SSR-safe. `dispose()` removes every listener and restores `touch-action`.
- **Gizmo rendering.** `TransformControls` builds its handles on the CPU each frame (lines, cones, cubes, squares, rings), keeping a constant screen size (under an orthographic camera from @margoengine/cameras: the same fraction of the view height at any `zoom` or `height`, with parallel-ray picking and drags). A frame graph pass (order 1000) turns lines into screen-space quads, sorts triangles back to front and draws them with alpha blending over the finished frame, with no depth test against the scene unless `occlude` is on. It uses WebGPU when the engine does, and a tiny WebGL2 program on the fallback backend.
- **Gizmo picking.** Hit tests are CPU-only in CSS pixels: arrows, scale axes and rings by pixel distance to their projection (back halves of rings lose ties), plane squares by a ray-plane intersection, center and view-ring handles by projected circles. Axes pointing at the camera and planes seen edge-on are hidden and unpickable.
- **Gizmo dragging.** Translate intersects the cursor ray with a plane through the handle (the axis plane most facing the camera, the handle plane, or the view plane), projects the offset onto the axis, and writes `inverse(parentWorld) x newWorld` as the local position, so parented meshes follow the cursor exactly. Rotation is the signed angle between the grab and current points on the ring plane (falling back to a screen tangent drag when the ring is edge-on), applied as `P^-1 R P` to the local quaternion, where P is the parent's world rotation. Scale is always local: the ratio of current to grab distance along the handle axis, or one handle length of drag up or right doubles the uniform scale. World matrices come from `engineRuntime(engine).store.matrices`. The gizmo stops the pointerdown event from reaching later listeners when it grabs a handle, and emits `dragging-changed` so you can disable `OrbitControls`.

## Options

| Option | Control | Default |
| --- | --- | --- |
| `enableDamping`, `dampingFactor` | Orbit, Map | `false`, `0.05` |
| `rotateSpeed`, `zoomSpeed`, `panSpeed` | Orbit, Map | `1`, `1`, `1` |
| `minDistance`, `maxDistance` | Orbit, Map, Trackball, Arcball | `0`, `Infinity` |
| `minPolarAngle`, `maxPolarAngle` | Orbit, Map, PointerLock | `0`, `PI` |
| `minAzimuthAngle`, `maxAzimuthAngle` | Orbit, Map | `-Infinity`, `Infinity` |
| `zoomToCursor`, `screenSpacePanning`, `keyPanSpeed` | Orbit, Map | `false`, `true` (`false` for Map), `7` px |
| `targetBounds` (`{min, max}` boxes the target) | Orbit, Map | `null` |
| `cursor`, `minTargetRadius`, `maxTargetRadius` (a sphere shell for the target) | Orbit, Map | `[0, 0, 0]`, `0`, `Infinity` |
| `zoom`, `minZoom`, `maxZoom`, `orthoZoom`, `projection` | Orbit, Map | the projection's zoom, `0`, `Infinity`, `false`, the engine's `cameras` plugin |
| `autoRotate`, `autoRotateSpeed` | Orbit, Map | `false`, `2` (one turn per 30 s) |
| `mouseButtons`, `touches`, `keys` | Orbit, Map, Trackball | Left rotates, middle dollies, right pans (Map: left pans, right rotates); one finger rotates, two dolly and pan (Map: pan, dolly and rotate); arrow keys (Trackball: A, S, D), using the exported `MOUSE` and `TOUCH` |
| `setProfile(profile)`, `profile` | Orbit, Map | `null` (same as `MARGO`); see Navigation profiles |
| `rotateSpeed`, `zoomSpeed`, `panSpeed`, `staticMoving`, `dynamicDampingFactor`, `noRotate`, `noZoom`, `noPan`, `enableRoll` | Trackball | `1`, `1.2`, `0.3`, `false`, `0.2`, `false`, `false`, `false`, `false` |
| `enableRotate`, `enableZoom`, `enablePan`, `rotateSpeed`, `zoomSpeed`, `panSpeed`, `enableDamping`, `dampingFactor`, `zoomToCursor`, `minZoom`, `maxZoom` | Arcball | `true`, `true`, `true`, `1`, `1`, `1`, `false`, `0.05`, `true`, `0`, `Infinity` |
| `enableFocus`, `pick`, `keyRotateStep`, `keyPanStep`, `keys` | Arcball | `true`, `null`, 5 degrees, `40`, arrows Q E + - Home |
| `movementSpeed`, `rollSpeed`, `dragToLook`, `autoForward`, `enableRoll` | Fly | `1`, `0.01`, `false`, `false`, `false` |
| `movementSpeed`, `lookSpeed`, `lookVertical`, `activeLook`, `heightSpeed`, `constrainVertical`, `verticalMin`, `verticalMax` | FirstPerson | `1`, `0.005`, `true`, `true`, `false`, `false`, `0`, `PI` |
| `pointerSpeed`, `movementSpeed`, `requireLock`, `keys` | PointerLock | `1`, `1`, `true`, WASD/arrows/R/F |
| `mode`, `space`, `pivot`, `size` | Transform | `'translate'`, `'world'`, `'median'`, `1` |
| `translationSnap`, `rotationSnap` (radians), `scaleSnap` | Transform | `null` |
| `heldSnap` (steps used while Ctrl or Meta is held and no snap is set), `keys` (shortcut key codes) | Transform | 0.25, 15 degrees, 0.1; W E R Q + - Escape |
| `showX`, `showY`, `showZ`, `visible`, `enabled` | Transform | `true` |
| `flipAxes`, `showDelta`, `occlude`, `occluder` | Transform | `false`, `true`, `false`, none; see Gizmo arrows, drag lines and occlusion |
| `offset`, `fixed` | Transform | `[0, 0, 0]`, `true`; see Gizmo offset, size and colours |
| `axisColors`, `hoveredColor`, `lineWidth` | Transform | red, green, blue; yellow; `2.5` |
| `element`, `order` | Transform | engine canvas, `1000` |
| `view` (one of `engine.views`: its camera, pointers inside its rectangle, drawn only there) | Transform | `null` (engine camera, whole element) |

## Limits

- Orbit, map, first-person, pointer-lock and walk controls do not roll (see above). Without `enableRoll`, trackball rotation cannot pass over the poles.
- Orthographic cameras come from @margoengine/cameras (dolly becomes ortho zoom there; pan and the gizmo read the orthographic height from `camera.matrix`).
- `attachMany` sizes each object along its own axes: under `world` space or another object's axes, a non-uniform stretch on a turned object gives its axes their share of the stretch instead of a shear.
- A ray's pick radius is 1.5 degrees about the ray (`rayHover`, `rayDown`), whatever the distance. The gizmo's size, the view ring and the flipped arrows still follow the engine camera.
- With `occlude` and no `occluder`, a handle hidden behind geometry can still be grabbed: picking is on the CPU and has no scene depth. A parent with non-uniform scale and rotation shears its children; `TransformControls` drags use the parent's rotation without the shear.
- `DragControls` moves a model whole: `recursive` and `transformGroup` follow core mesh children, not the nodes of a model. Skinned models are grabbed in their bind pose (see @margoengine/bvh).

## Tests

`npm test` in `packages/controls` runs Node tests with synthetic pointer, wheel and keyboard events on a fake element, and real core `Camera`, `TransformStore` and `Engine` objects with a stub renderer: orbit azimuth and polar mapping, polar and azimuth clamping and pole safety, damping convergence at 30 and 60 fps, dolly limits, zoom to cursor keeping the world point on its pixel, screen-space and ground panning moving target and position equally, keyboard pan, touch rotate and pinch, `enabled`, `reset`, auto-rotate, map panning, trackball rotation, coasting and pole guard, roll in fly and trackball (Q and E at `rollSpeed`, the body axes, looping past the vertical, an orthonormal frame after long flights and tumbles, the rendered matrix, reset), the arcball (sphere mapping continuity, the angle and axis of a drag across the centre, roll and passing over the pole, an orthonormal frame after 1000 drags, pan and zoom keeping the cursor point on its pixel under perspective and fixed-size orthographic cameras, distance and zoom limits, damping coming to rest at 30 and 60 fps, enable flags and reset, the gizmo's size and dimming, double-click focus and the keyboard), fly and first-person movement and look, pointer-lock look limits and WASD helpers, and the gizmo: translating along an axis by a known screen drag, constant screen size, picking, drags and orbit pan under an orthographic camera at several zooms, snapping in world and local space, plane and screen handles, ring rotation following the cursor, rotation snapping, more than 180 degrees of rotation, the view ring and free rotation, axis and uniform scale with snapping, local versus world space, a parented mesh (translate, rotate, scale) under a rotated and scaled parent, hover highlighting, several objects about each pivot in each space (`tests/transform-many.test.js`), arrows flipping to the camera with a margin and held during a drag, the delta line and swept arc, axis toggles, OrbitControls disabled during a gizmo drag, tessellation of every mode, and listener and plugin cleanup. Drag tests move a box under a scaled parent on the view plane (checked against an independent ray-plane intersection), along an axis and on the ground plane, a gltf/pbr model by touch under an orthographic camera (600 CSS pixels for 6 world units), and check events, hover, misses falling through to later listeners, other fingers, disposed meshes and models, and cleanup; `tests/drag-modes.test.js` covers rotate mode under a rotated parent, about an axis and as a trackball, groups that move and turn together, and `recursive` and `transformGroup`.

`tests/third-person.test.js` covers `ThirdPersonControls` on real core engines: the arm's place and the view kept from the
attached camera, a wall pulling the arm in within the frame with the camera on the near side at every yaw of a full turn,
the eased return at 30 and 60 fps, a corridor wall beside the pivot not collapsing the arm, the shoulder, the subject,
children and `ignore` skipped, explicit colliders, the spring settling alike at 30 and 60 fps, `snap`, drag, wheel, pinch and pitch limits, a
disposed subject and listener cleanup.

`tests/walk.test.js` covers `WalkControls` on real core engines with generated geometry, at fixed time steps: a 12-step
stair of 0.18 m risers climbed and descended with the eye never jumping more than 6 cm a frame, 0.19 m climbed and 0.25 m
and 0.4 m refused; sliding along a wall at the radius; a zero-thickness glass pane and corner never crossed at 30 m/s
at 10, 30 and 60 frames per second; eye height within 2 mm over hardwood, a 12 mm rug and a deck with 1 cm gaps; a
0.35 m gap bridged and a 0.8 m gap fallen into; 20° and 40° ramps climbed, 60° blocked; no jump at the default
`jumpSpeed`, a jump's apex equal to v²/2g within 1e-6 m at 30 and 144 updates a second, one jump per press, a ceiling stopping the head, a 2 m fall landing;
crouching under a 1.3 m overhang and standing only past it; the generated two-storey house (`tests/house.js`) walked
from the deck through the door, over the rug, through the doorway and up 16 stairs to the upper floor with the capsule
never closer than its radius minus 1 cm to any box or the glass; the dollhouse view out and back (never vertical,
framed on the bounds, orthographic through a `CameraProjection`, an orbit drag, a `FloatingOrigin` rebase, a toggle
cancelled half way); a gltf/pbr model wall, hidden models, explicit and changed collider lists; and keys, drag and
pointer-lock look, touch thumbstick and drag-look, a gamepad, and listener and plugin cleanup.
`npm run test:browser:walk` (real GPU, not in CI) walks the same house in Edge with the real W key, screenshots each
waypoint and the dollhouse, checks the capsule's clearance every frame and zero WebGPU errors, and drives the touch
thumbstick on a 390 × 844 phone viewport.

`tests/profiles.test.js` covers navigation profiles: a recorded sequence of mouse drags (every button and modifier),
wheel notches (pixel, line, page, Ctrl pinch, Shift, Alt), a double middle click, one- and two-finger touch and keys
(`tests/orbit-replay.json`, recorded from OrbitControls before profiles existed) replays to bit-identical camera
positions, targets, `preventDefault` flags, states and events with no profile, with `setProfile(MARGO)` and after
switching from Blender back to it, plain, damped and with zoom to cursor; per profile, every bound and unbound
button/modifier gives the expected motion (rotate, pan, dolly in or none), the wheel direction, zoom to cursor, one finger
and pinch; double clicks (and not slow or moved ones) and fit keys dispatch `fit`; view keys snap (eased with damping);
Blender numpad 5 toggles a CameraProjection; under an orthographic projection the wheel is ortho zoom keeping the point
under the cursor, and Rhino right drag pans there; and the browser conflicts above (Alt keyup, context menu, middle
`mousedown`, Ctrl + wheel, browser shortcuts passing through). Re-record the replay only for an intended change:
`RECORD=1 node --test tests/profiles.test.js`.

`npm run test:browser` (a real-GPU script, not in CI) starts a real engine in Chromium (or Edge, honoring `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE` and `BROWSER_ARGS`) and drives it with `page.mouse`: an orbit drag moves the rendered box to its newly projected position, the wheel enlarges it, the gizmo draws over the mesh, hover turns the X arrow yellow, dragging the X arrow 100 px moves the mesh and the rendered box by the expected amount while the camera stays still, dispose removes every canvas listener and the overlay pass, `occlude` hides the gizmo behind a wall on WebGPU and WebGL2, there are zero WebGPU validation errors, and the WebGL2 backend draws and removes the same overlay. `npm run size` prints the gzip size of the whole bundle and of each control tree-shaken on its own.

Apache-2.0 licensed.

### Scene ownership and disposal

Camera controls and gizmos retain the actual update or overlay plugin they
register. Creating them during a secondary scene's setup binds that wrapper to
the scene. dispose() disconnects input and removes that exact registration;
removing the owning plugin or scene also disposes the control. Repeated disposal
preserves any replacement with the same name and plugins in other scenes.

The ordinary attach/dispose example above uses the same lifecycle. The
scene-owner suite covers all nine camera control classes and both gizmo wrappers,
including initialization failures and scene/engine disposal.

## Geospatial camera: `@margoengine/controls/geospatial`

`GeospatialControls` orbits a geodetic point on the WGS84 globe by heading, pitch and range. Drag pans along the surface,
right or modified drag turns and tilts, the wheel zooms toward the cursor, and `flyTo` flies the optimal zoom-and-pan path.
The eye is kept `clearance` metres (default 2) above the ground height your `heightAt(longitude, latitude)` returns; it
is a height query only (a function over a terrain, a height grid or a raycast), never a physics body. Angles are
radians and lengths metres everywhere; convert with `degToRad`. The geodesy (geodetic/ECEF, ENU, Karney geodesics,
`orbitPose`) is `@margoengine/math/geo`, also what `@margoengine/tiles` uses.

```ts
import {GeospatialControls} from 'margoengine/controls/geospatial';
import {degToRad} from 'margoengine/math/geo';
import {Engine} from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
const hills = (lon: number, lat: number) => 300 * Math.max(0, Math.sin(lon * 4000) * Math.cos(lat * 4000));
const camera = new GeospatialControls(engine, undefined, {
  view: {longitude: degToRad(-122.4), latitude: degToRad(37.8), range: 5000, pitch: degToRad(50)},
  heightAt: hills,
  clearance: 10,
});
const controller = new AbortController();
// The flight advances with the engine's frames; the promise settles when it lands (true) or is cancelled (false).
camera
  .flyTo({longitude: degToRad(2.35), latitude: degToRad(48.85), range: 3000, heading: degToRad(30)}, {duration: 1, signal: controller.signal})
  .then((arrived) => console.log(arrived, camera.terrainLift));
```

### Planet scale: street level to orbit

Core draws in float32, so a camera written at Earth-centred coordinates (6,370 km out) shakes and then collapses near
the ground. Pass `origin`, a `FloatingOrigin` from `@margoengine/cameras/origin`: the controls keep every pose in
float64 world coordinates and write the camera, picks and sweeps in the origin's local coordinates, so street level
renders as steadily as orbit (under 0.05 px of jitter at any distance, docs/large-coordinates.md). A local `frame`
does the same for one site. With `clipPlanes` (default true), near is 1% of the eye's height above the ground (from
`heightAt`; 5 mm at the least), so a walker on a 1,650 m plateau gets centimetres. Far reaches the eye's horizon plus
the horizon of 9,000 m peaks, so mountains past the horizon still draw. Core's reversed float depth carries the ratio.

```ts
import {GeospatialControls} from 'margoengine/controls/geospatial';
import {FloatingOrigin} from 'margoengine/cameras/origin';
import {degToRad} from 'margoengine/math/geo';
import {Engine} from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
const origin = FloatingOrigin.attach(engine);
const camera = new GeospatialControls(engine, undefined, {
  origin,
  heightAt: () => 1650, // Boulder's plateau, or a terrain or tiles height query
  view: {longitude: degToRad(-105.27), latitude: degToRad(40.02), height: 1655, range: 20, pitch: 0.2},
});
console.log(camera.camera.near, camera.camera.far); // centimetres; the horizon plus the far peaks
// Place your scene through the origin (float64 world, here Earth-centred): origin.place(mesh, worldPosition).
```

### Open worlds: terrain, tiles and biomes

A local world (a terrain or a biomes world laid out in metres around a site, a tileset in its east-north-up frame)
needs two options. `frame` says where the world sits on the globe: a 4x4 ECEF-to-world matrix, or the `TilesRenderer`
itself (its `frame`). Poses, picks and sweeps then go through it, and the camera stays near the world origin, so
nothing jitters. `ground` is the world-space ground: a terrain `TerrainQuery` (`height(x, z)`), a biomes world
(`heightAt(x, z)`) or a function. It becomes the `heightAt` for clearance, picking, walking and the height readouts,
with no conversion. Over 3D Tiles, `tilesHeightQuery` from `@margoengine/tiles/height` is the `heightAt`. The scene's
meshes are hit by the bvh as before.

```ts
import {GeospatialControls} from 'margoengine/controls/geospatial';
import {cartographicToEcef, degToRad, enuBasis} from 'margoengine/math/geo';
import {Engine} from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
// A valley laid out in metres around a site in the Rockies: x east, y up, z south.
const site = {longitude: degToRad(-105.6), latitude: degToRad(40.3), height: 2500};
const b = enuBasis(site.longitude, site.latitude),
  c = cartographicToEcef(site.longitude, site.latitude, site.height),
  rows = [b.east, b.up, b.north.map((v) => -v)],
  t = rows.map((r) => -(r[0]! * c[0] + r[1]! * c[1] + r[2]! * c[2]));
const frame = [0, 1, 2].flatMap((k) => [rows[0]![k]!, rows[1]![k]!, rows[2]![k]!, 0]).concat([t[0]!, t[1]!, t[2]!, 1]);
const valley = (x: number, z: number) => 80 * Math.sin(x / 300) * Math.cos(z / 400); // or a TerrainQuery, a biomes world
const camera = new GeospatialControls(engine, undefined, {
  frame,
  ground: valley,
  view: {...site, range: 1500, pitch: degToRad(30)},
});
console.log(camera.camera.position, camera.heights.terrain); // near the origin, metres above the valley floor
await camera.setMode('walk', {duration: 0}); // walk the valley floor
```

### Readouts, events and saved views

`heights` gives the eye's height above the ellipsoid, above the ground directly below it (the highest of `heightAt`,
the scene and `raycast`) and above mean sea level: by default from the EGM96 15' grid of
`@margoengine/controls/geoid`, loaded the first time `heights` is read (null until then; a `geoid` event says it is
in, `geoid-error` that it could not load), or your own `geoid(longitude, latitude)` query, or none with `geoid: null` (null
without one). `orientation` is the camera's heading, pitch and roll in the ENU frame at the eye, for a compass or an
attitude indicator. `resetNorth()` turns to heading 0 about the centre. Events: `compass` (`heading`) whenever the
heading changes, `mode` on a mode switch, and `moveend` (`view`) once the view settles after a drag, glide, flight or
key move. `saveView()` returns the view and mode as plain JSON and `restoreView(state)` flies back to it.
`toHash()` and `GeospatialControls.parseHash(hash)` give a link form, `#geo=lat,lon,height,range,heading,pitch,mode`
in degrees and metres (other `&` parameters are kept); `hash: true` starts from the page's hash and rewrites it on
each `moveend` without adding history entries.

```ts
import {GeospatialControls} from 'margoengine/controls/geospatial';
import {degToRad} from 'margoengine/math/geo';
import {Engine} from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
const camera = new GeospatialControls(engine, undefined, {
  view: {longitude: degToRad(-84.5), latitude: degToRad(45.8), range: 3000, heading: degToRad(120)},
  geoid: () => -35, // the EGM96 undulation near the Straits of Mackinac, about -35 m
  hash: true,
});
camera.addEventListener('compass', (event) => console.log('heading', event.heading));
camera.addEventListener('moveend', () => localStorage.setItem('view', JSON.stringify(camera.saveView())));
console.log(camera.heights, camera.orientation, camera.toHash());
await camera.resetNorth({duration: 0});
```

### Mean sea level: `@margoengine/controls/geoid`

`loadEGM96({url, signal})` loads the EGM96 15-minute geoid grid of the US National Geospatial-Intelligence Agency
(public domain), packed as 721 x 1441 little-endian int16 centimetres in `egm96-15.bin` beside the entry (2,077,922
bytes), and returns a `Geoid`: `undulation(longitude, latitude)` (radians in, metres of mean sea level above the
ellipsoid out, bilinear) and `query`, the function the camera's `geoid` option takes. `new Geoid(grid)` reads any
regular latitude-longitude grid, and `packGeoid(metres)` quantises heights to int16 centimetres. The packed file is
made from NGA's `WW15MGH.GRD` with `node scripts/geoid/pack-egm96.mjs path/to/WW15MGH.GRD`; the controls build copies
it into `dist`. A missing file rejects with a `failed` MargoError that says how to make it.

```ts
import {Geoid, loadEGM96, packGeoid} from 'margoengine/controls/geoid';
import {degToRad} from 'margoengine/math/geo';

// A tiny hand-made grid: 90 degree spacing, heights in metres.
const coarse = new Geoid({data: packGeoid([10, 10, 10, 10, 10, -20, 0, 20, 40, -20, 5, 5, 5, 5, 5]), rows: 3, columns: 5, step: 90});
console.log(coarse.undulation(degToRad(45), 0)); // -10, halfway between -20 and 0
const egm96 = await loadEGM96().catch((error) => (console.warn(error.message), null));
console.log(egm96?.undulation(degToRad(-84.5), degToRad(45.8))); // about -35 m when the grid is installed
```

### Collision

The eye and the four corners of the near plane stay `clearance` metres clear of every surface, so the near plane never
cuts into a hillside or a wall. Each update the arm from the orbit centre to each of those five points is swept against
the engine scene (bvh, faces turned toward the centre only) and your `raycast`: a building between the centre and the
eye pulls the eye in front of it (`collisionRange` reads the range in use). Then the centre is lifted until all five
points clear the `heightAt` terrain and any roof or tile surface within `clearance` below them. Flights, drags and
`setView` all pass through it. `underground: true` turns it all off for subsurface and underwater views. No physics:
only ray and height queries.

```ts
import {GeospatialControls} from 'margoengine/controls/geospatial';
import {degToRad} from 'margoengine/math/geo';
import {Engine, box} from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
// A 200 m tower at longitude 0, latitude 0 (ECEF +X is up there; the world is the Y-up (x, z, -y) of ECEF).
engine.createMesh().setGeometry(box()).setPosition([6378137 + 100, 0, -300]).setScale([200, 300, 100]);
const camera = new GeospatialControls(engine, undefined, {
  view: {longitude: 0, latitude: 0, heading: degToRad(-90), pitch: 0.1, range: 600},
  clearance: 3,
});
console.log(camera.collisionRange < 600); // true: the tower stands between the centre and the eye
camera.underground = true; // look from below the ground: no floor, no sweeps
```

### Feel: glide, presets, keys and reduced motion

A fling glides on and slows down, each axis by its own time constant: `inertia` `{pan: 0.3, rotate: 0.25, zoom: 0.2}`
seconds (0 stops that axis at once; `setInertia` changes some). A pause of more than 80 ms before release is a stop, not
a fling. `preset` picks the buttons and feel: `'globe'` (default; left drag pans, right or modified drag turns and tilts,
double click zooms in two times, Shift + double click out), `'map'` (the same with a longer pan glide, 0.45 s) or
`'dcc'` (middle drag orbits, Shift + middle pans, Ctrl + middle zooms, the left button stays free for picking, no glide
and no double click, as in DCC tools such as Blender and Maya); `applyPreset` switches later. In the orbit modes the
keys pan along the heading at `keyPanSpeed` (1) heights above the ground per second (W/A/S/D or the arrows), so a pan
feels the same at street level and from orbit; Q/E turn, R/F tilt, + and - zoom two times a second, Shift is 4 x.
`reducedMotion` (default: the user's `prefers-reduced-motion` setting) turns the glide off and lands flights, paths and
mode switches at once unless you pass a `duration`.

```ts
import {GeospatialControls} from 'margoengine/controls/geospatial';
import {degToRad} from 'margoengine/math/geo';
import {Engine} from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
const camera = new GeospatialControls(engine, undefined, {
  view: {longitude: degToRad(-87.6), latitude: degToRad(41.9), range: 5000, pitch: degToRad(60)},
  preset: 'map',
  inertia: {rotate: 0}, // turns stop when you let go; pans still glide
});
camera.keyPanSpeed = 0.5; // slower key pans
console.log(camera.preset, camera.inertia, camera.reducedMotion);
camera.applyPreset('dcc'); // middle-button orbit for a modelling session
```

Blender and Maya are trademarks of their respective owners; they are named only to describe the button layout.

Touch, pen and gamepad: one finger pans like the left button; two fingers pinch to zoom about their midpoint, twist to
turn the heading and move up or down together to tilt (no tilt in map), and a quick release glides on. A pen's tip
pans and its barrel button turns, as the mouse buttons do. With `gamepad: true` the first connected pad is read each
update: the left stick pans at `keyPanSpeed` heights above the ground per second (moves in first person), the right
stick turns and tilts (looks), the right trigger zooms in and the left out (rise and sink in fly), the left stick
press is the 4 x boost; sticks rest inside a 0.15 dead zone.

```ts
import {GeospatialControls} from 'margoengine/controls/geospatial';
import {degToRad} from 'margoengine/math/geo';
import {Engine} from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
const camera = new GeospatialControls(engine, undefined, {
  view: {longitude: degToRad(-105), latitude: degToRad(40), range: 8000, pitch: degToRad(50)},
  gamepad: true,
});
window.addEventListener('gamepadconnected', () => console.log('sticks fly the camera now'));
camera.gamepad = false; // turn the pad off again, for a menu
```

### Navigation modes

`mode` (option, default `'globe'`) picks how input moves the camera, and `setMode(mode, {duration})` switches with a
smooth move. `globe`: left drag pans the surface, right or modified drag turns and tilts. `local`: the same orbit about a
site (a city, a valley) with the buttons swapped, so a left drag turns about the centre. `map`: straight down at
`maxPitch`; a right drag turns the heading only. `fly`: first person, a drag looks about the eye (grab the world),
W/A/S/D or the arrows move along the view, E/Q (or PageUp/PageDown) rise and sink, Shift is 4 x; the speed is
`flySpeed` (1) heights above the ground per second, at least 2 m/s, so it slows near the ground. `walk`: first person on
the ground, the eye `eyeHeight` (1.7 m) above the higher of `heightAt` and the scene or `raycast` surface below it,
moving at `walkSpeed` (1.4 m/s; about 15 drives a car). The wheel moves forward in fly and walk. Keys are read on
`keyTarget` (default the element's document). Entering fly keeps the pose exactly; entering globe or local from first
person keeps it when the middle of the screen is on the ground; walk lands at the surface in the middle of the screen
with a level view. `look(heading, pitch)` and `moveEye(forward, right, up)` do the same from code, and every switch
emits a `mode` event.

```ts
import {GeospatialControls} from 'margoengine/controls/geospatial';
import {degToRad} from 'margoengine/math/geo';
import {Engine} from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
const camera = new GeospatialControls(engine, undefined, {
  view: {longitude: degToRad(-105.6), latitude: degToRad(40.3), range: 4000, pitch: degToRad(40)},
  heightAt: (lon, lat) => 2500 + 400 * Math.sin(lon * 900) * Math.cos(lat * 700),
  walkSpeed: 3,
});
camera.addEventListener('mode', (event) => console.log('mode', event.mode));
// Walk down to the trail in the middle of the screen, then take a few steps along it.
await camera.setMode('walk', {duration: 0});
camera.moveEye(10, 0);
console.log(camera.eye.height); // 1.7 m above the ground under the eye
// Fly from here; the engine's frames run any move a switch needs.
camera.setMode('fly').then(() => camera.look(0, degToRad(-10))); // then look a little above the horizon
```

### Cinematic paths

`followPath(views, {duration, speed, easing, signal, cancelOnInput})` moves through a list of views on a centripetal
Catmull-Rom curve (Yuksel, Schaefer and Keyser 2011): it passes every view exactly, does not loop or overshoot when the
views are unevenly spaced, and carries heading, pitch and range along on the same knots. Fields a view leaves out keep
the previous view's value. Without `duration` the length sets it (`speed` 0.6 screen heights a second, at least 1 s).
It eases in and out with smootherstep, and a press or the wheel cancels it unless `cancelOnInput` is false.

```ts
import {GeospatialControls} from 'margoengine/controls/geospatial';
import {degToRad} from 'margoengine/math/geo';
import {Engine} from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
const camera = new GeospatialControls(engine, undefined, {
  view: {longitude: degToRad(-83), latitude: degToRad(42), range: 2000, pitch: degToRad(40)},
});
// Along the Detroit River shore, turning toward the lake and climbing.
camera
  .followPath(
    [
      {longitude: degToRad(-82.98), latitude: degToRad(42.01), heading: degToRad(30), range: 1500},
      {longitude: degToRad(-82.95), latitude: degToRad(42.03), heading: degToRad(80), pitch: degToRad(25)},
      {longitude: degToRad(-82.9), latitude: degToRad(42.02), heading: degToRad(170), range: 4000},
    ],
    {cancelOnInput: false},
  )
  .then((done) => console.log('path done', done));
console.log(camera.flightTime?.duration); // seconds, from the path length
```

### Flights and framing

`flyTo` follows the optimal zoom-and-pan path of van Wijk and Nuij (2003): it climbs, crosses the shortest geodesic and
descends so the apparent speed stays even, and the path length sets the duration (`speed` 1.2 screen heights a
second, at least 1 s, at most `maxDuration` 10 s) unless you give `duration`. `curve` (1.42) is their rho: higher climbs
sooner, near 0 pans flat. A pointer press or the wheel cancels it (`cancelOnInput`, default true), as do `signal`,
another flight, `setView` and `dispose`; the promise then resolves false. `zoomPanPath(w0, w1, u1, rho)` exposes the
path itself. `flyToBoundingSphere(centre, radius)` frames a sphere with `padding` (1.1) room, and `fitBounds(box)` frames
a longitude/latitude box from above (`pitch` overrides it); both take every flight option.

```ts
import {GeospatialControls, zoomPanPath} from 'margoengine/controls/geospatial';
import {degToRad} from 'margoengine/math/geo';
import {Engine} from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
const camera = new GeospatialControls(engine, undefined, {
  view: {longitude: degToRad(-87.6), latitude: degToRad(41.9), range: 2000, pitch: degToRad(45)},
});
// Chicago to Detroit: the duration comes from the path length; the engine's frames advance it.
camera
  .flyTo({longitude: degToRad(-83.05), latitude: degToRad(42.33), range: 1500})
  // Then Lake Michigan from above, with a fifth more room.
  .then(() =>
    camera.fitBounds(
      {west: degToRad(-88), south: degToRad(41.6), east: degToRad(-84.8), north: degToRad(46.1)},
      {padding: 1.2, duration: 2},
    ),
  );
console.log(camera.flightTime?.duration); // seconds, between 1 and 10
console.log(zoomPanPath(1000, 1000, 1e6).S); // the path length in screen widths
```

### Surface-true picking

Zoom, pan and turn grab the real surface, not the ellipsoid. `pick(x, y)` returns the nearest hit of the engine's
visible meshes and models (terrain meshes, 3D Tiles, glTF; the bvh `Raycaster`, option `scene`, default true), your own
world-space `raycast(origin, direction, far)` and a march over `heightAt`; only on a miss does it fall back to the
ellipsoid raised to the centre height. The wheel slides the eye along the cursor ray toward the hit, so the point under
the cursor stays there; a left drag keeps the grabbed point under the cursor (Newton steps on the centre, heading kept);
a right drag first re-centres the orbit on the surface in the middle of the screen, so a mountain top turns in place.

```ts
import {GeospatialControls} from 'margoengine/controls/geospatial';
import {degToRad} from 'margoengine/math/geo';
import {Engine} from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
const camera = new GeospatialControls(engine, undefined, {
  view: {longitude: degToRad(-105.6), latitude: degToRad(40.3), range: 20000, pitch: degToRad(40)},
  heightAt: (lon, lat) => 2500 + 1500 * Math.sin(lon * 900) * Math.cos(lat * 700),
  // Your own query in world coordinates, e.g. a TerrainQuery or a tiles height grid: metres to the hit, or undefined.
  raycast: () => undefined,
});
const hit = camera.pick(200, 150);
console.log(hit?.source, hit?.height); // 'terrain' and the ground height there, when the canvas has a size
```

Options: `view`, `heightAt`, `clearance` (2), `minPitch` (0), `maxPitch` (PI/2), `minRange` (1), `maxRange` (4 x 6378137),
`clipPlanes` (true), `zUp` (false: world is the engine's Y-up `(x, z, -y)` of ECEF), `scene` (true), `colliders` (null:
everything visible), `raycast` (none), `raycaster` (a new one), `underground` (false), `mode` ('globe'), `eyeHeight`
(1.7), `walkSpeed` (1.4), `flySpeed` (1), `keyTarget` (the element's document), `preset` ('globe'), `inertia`
({pan: 0.3, rotate: 0.25, zoom: 0.2}), `reducedMotion` (the `prefers-reduced-motion` setting), `gamepad` (false), `geoid` ('egm96'), `hash` (false), `frame` (ECEF, or its Y-up view), `ground` (none), `origin` (none). Sources: NIMA TR8350.2 (WGS84);
Karney, "Algorithms for geodesics", J. Geodesy 87, 2013; Bowring, Survey Review
23 (181), 1976; Jankowski and Hachet, "A Survey of Interaction Techniques for Interactive 3D Environments", Eurographics
STAR 2013, https://doi.org/10.2312/conf/EG2013/stars/065-093 (grab-the-surface pan and point-of-interest zoom); Khan et
al., "HoverCam", I3D 2005, https://doi.org/10.1145/1053427.1053439 (orbiting about the surface under the view); van Wijk
and Nuij, "Smooth and efficient zooming and panning", IEEE InfoVis 2003, https://doi.org/10.1109/INFVIS.2003.1249004
(the flight path, equations 9 to 12); Yuksel, Schaefer and Keyser, "Parameterization and applications of Catmull-Rom
curves", Computer-Aided Design 43 (7), 2011, https://doi.org/10.1016/j.cad.2010.08.008 (the cinematic path). Limits: `docs/limits.md`, "Geospatial camera".

## Globe navigation: `@margoengine/controls/globe`

`GlobeControls` grabs an ellipsoid with the left mouse button or one finger, zooms
toward its hit under the wheel or pinch, and tilts about a surface hit with the
right/middle button, modified left button or two fingers. The same continuous
coordinates work from orbit down to the street. The outward ellipsoid normal
transports the camera frame between grabbed points; it preserves the grabbed
pixel without assuming the ellipsoid is a sphere.

```ts
import {Engine} from 'margoengine/core';
import {FloatingOrigin} from 'margoengine/cameras/origin';
import {GlobeControls} from 'margoengine/controls/globe';

const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: {position: [0, 8_000_000, 22_000_000], target: [0, 0, 0], near: 100_000, far: 100_000_000},
});
const origin = FloatingOrigin.attach(engine);
const globe = new GlobeControls(engine, undefined, {origin});
// Add your georeferenced scene in the same frame; the default ellipsoid is Y-polar WGS84 in metres.
console.log(globe.altitude, globe.pick(0, 0)); // pick returns a local world point, or null on sky
engine.start();
```

The real reference data are NGA WGS84's equatorial radius 6,378,137 m and inverse
flattening 298.257223563 (US government factual geodetic parameters, public
domain; [NGA WGS84](https://earth-info.nga.mil/index.php?action=wgs84&dir=wgs84)).
`radii` defaults to `[6378137, 6356752.314245, 6378137]`; pass Z-polar radii
`[6378137, 6378137, 6356752.314245]` for an unrotated ECEF scene. `centre` is
`[0,0,0]`, global with `origin`, otherwise local. The floating origin shifts an
active grab too, and its subscription is removed on disposal.

Options: `minAltitude` (1 world unit), `maxAltitude` (Infinity), `maxTilt`
(89 degrees in radians), `clipPlanes` (true: near = 1% of radial altitude; far
reaches twice the reference horizon distance plus altitude), and `origin` (none).
Altitude is **radial height**, not geodetic height or terrain clearance.
Properties `enablePan`, `enableZoom`, `enableTilt` default true; `zoomSpeed` is
1 (500 wheel pixels doubles distance); `rotateSpeed` is PI radians per viewport
height. Without `clipPlanes`, the app owns valid near/far settings.

`pick(x,y)`, `grab(previousHit,x,y)`, `zoomAt(x,y,wheelPixels)` and
`tilt(hit,yaw,pitch)` accept CSS pixels and radians. A positive `pitch` moves the
eye away from the surface normal at the hit (toward the horizon), a negative one back
toward straight above it, kept between 0 and `maxTilt` whichever way `camera.up`
points; the horizon stays the right way up. Hits are in the current local
frame. `normal(hit)` returns its geodetic unit normal. Constructor values are
copied; invalid coordinates/limits throw. Events are `start`, `change`, `end`.
Like other controls, a bare camera and element can be passed instead of an
engine; `update()` reports whether a programmatic or input operation moved it.

Limits: perspective camera, axis-aligned reference ellipsoid, no terrain/mesh
collision, no inertia; dragging a point onto sky leaves it at the last valid
surface hit. Altitude/tilt constraints take precedence over pixel anchoring.
Use one camera controller at a time. GPU tests use synthetic geometry as
correctness fixtures, not as an asset demonstration.


## Orbit collision: optional /collide

Import OrbitControls or MapControls from `@margoengine/controls/collide` to shorten
the camera arm against explicit mesh/model blockers. The ordinary root controls
keep their existing behavior. `colliders` defaults to [] (no blockers); null tests
every visible scene mesh/model. Supply a Raycaster to configure layers, side and
filter; the default raycaster tests both triangle sides. Hidden objects follow
the raycaster's visibility rules. Skinned geometry is tested in its bind pose.

Each collision update samples five rays: the center and four near-plane corners.
This is sampled camera clearance, not a swept volume or character collision solver.
`clearance` defaults to 0.01 world units before the closest hit. Obstruction shortens
the arm immediately; `returnTime` (0.2 seconds) eases it back when clear, or 0 restores
it immediately. Both options require finite nonnegative values. The requested orbit
distance remains available as desiredDistance; armLength reports the actual distance
and rays reports 0 with no blockers or 5 when testing. The inherited orbit/map input,
damping and limits still apply. Dispose to release the control's input/update plugin.

```ts
import {Engine, box, PbrMaterial} from '@margoengine/core';
import {OrbitControls} from '@margoengine/controls/collide';
const canvas = document.body.appendChild(document.createElement('canvas'));
const engine = await Engine.create(canvas, {camera: {position: [0, 0, 5], target: [0, 0, 0]}});
const wall = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial()).setPosition([0, 0, 3]).setScale([4, 4, 0.2]);
const orbit = new OrbitControls(engine, {colliders: [wall], clearance: 0.02, returnTime: 0.2});
orbit.update(1 / 60);
if (orbit.armLength >= orbit.desiredDistance || orbit.rays !== 5) throw new Error('Camera arm was not shortened');
engine.render();
orbit.colliders = []; // The requested distance now restores over subsequent updates.
orbit.update(1 / 60);
orbit.dispose(); engine.dispose(); canvas.remove();
```

## Bounding-box editing: optional /box-gizmo

`BoxGizmo` attaches to one live core mesh with geometry from its engine. Eight
corner handles scale; twelve edge handles rotate about their local axes. Call
handles() for world-space positions with stable corner-0..7 and edge-0..11 ids.
handleSize is 12 CSS pixels by default. uniformScaling defaults true; false scales
each screen-visible local axis. scaleFromCenter defaults false, keeping the opposite
corner fixed while scaling; true uses the center. Edge rotation uses the center, and the
grabbed edge follows the pointer around its axis at any box size or camera distance.
scaleSnap is a scale-ratio step and rotationSnap is radians; both default null and
require positive finite values when set. Negative/zero crossing scales are prevented.

Pointer input picks handles automatically. beginDrag(x,y,id?), dragTo(x,y) and
endDrag() expose the same operation in CSS pixels. cancelDrag(), Escape or pointer
cancellation restores the original transform. dragging-changed, start, end, change
and objectChange events let an app suspend camera input and group its own undo.
refreshBounds() rescans local geometry vertices after geometry edits. detach ends
an active edit and clears the target. Disposal disconnects input, restores its owned
touch-action style and removes the overlay/update plugins; mesh ownership stays with
the app. A parent with rotated nonuniform scaling can introduce shear outside the
mesh's position/quaternion/scale representation.

```ts
import {Engine, box, PbrMaterial} from '@margoengine/core';
import {BoxGizmo} from '@margoengine/controls/box-gizmo';
import {OrbitControls} from '@margoengine/controls';
const canvas = document.body.appendChild(document.createElement('canvas'));
const engine = await Engine.create(canvas);
const mesh = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial());
const orbit = new OrbitControls(engine);
const gizmo = new BoxGizmo(engine, {scaleSnap: 0.1, rotationSnap: Math.PI / 12});
gizmo.attach(mesh);
gizmo.addEventListener('dragging-changed', event => {orbit.enabled = !event.value;});
console.log(gizmo.handles()); // Eight corners and twelve edges.
gizmo.refreshBounds();
engine.render();
// Keep attached while editing; at teardown:
gizmo.dispose(); orbit.dispose(); engine.dispose(); canvas.remove();
```

## Product and scroll presentations: optional /presentation

This entry uses the optional `@margoengine/tween` peer for its springs. Importing
root controls does not import it. PresentationControls rotates a live product mesh
from the same engine; an empty product root is supported when it has drawable
descendants. By default only a product/descendant hit starts dragging; global: true
accepts the whole element. polar limits local X rotation to [-PI/2,PI/2], azimuth
defaults to unbounded local Y, and both intervals must contain zero. speed defaults
1, zoom defaults 1 (scale at the polar limit), and snap defaults false (true springs
back to the starting pose on release). spring defaults are stiffness 170, damping
26 and precision 0.000001; duration/bounce Spring options may be supplied instead.
angles reads current pitch/yaw. reset(immediate=false) returns to the initial pose.

```ts
import {Engine, box, PbrMaterial} from '@margoengine/core';
import {PresentationControls} from '@margoengine/controls/presentation';
const canvas = document.body.appendChild(document.createElement('canvas'));
const engine = await Engine.create(canvas);
const product = engine.createMesh();
engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial()).setParent(product);
const controls = new PresentationControls(engine, product, {snap: true, polar: [-0.4, 0.4], zoom: 1.1});
controls.reset(true);
engine.render();
controls.dispose(); engine.dispose(); canvas.remove();
```

ScrollArea requires a mounted canvas. It creates a focusable native scroll viewport
and content slot above it, temporarily positioning a static parent. pages defaults
1, distance 1, horizontal false and prepend false; pages must be finite >=1 and
distance finite >0. Dispose ScrollControls before disposing the area; the area owns
only its DOM and parent positioning, never the canvas or content supplied by the app.

ScrollControls accepts a native scroller or a wheel surface (default engine canvas).
pages/distance/horizontal have the same defaults; infinite defaults false, damping
0.2 seconds, maxSpeed Infinity and eps 0.00001. Native scroll uses the element's
actual scroll extent. Wheel-only progress uses pages, distance and viewport size.
Infinite progress wraps offset into [0,1) while retaining movement through the seam.
delta is signed progress change. setProgress(progress,immediate=false) drives it in
code; in infinite mode progress names a place on the loop (1.25 and 0.25 are the same
place) and the offset takes the short way to it, at most half a loop. A wheel page
step (deltaMode 2) is one element height, or one width when horizontal. range(from,length,margin=0), curve(...) and visible(...) derive normalized
section progress, a bell-shaped value and membership, respectively.

PathControls (also MotionPathControls) samples any path with at(t), using uniform
arc length when length and atDistance are available, including a Spline. By default
it drives the camera, looks along the path, loops, starts at offset 0 and smooths
progress for 0.1 seconds; maxSpeed is Infinity, lookAhead 0.001 and focusDamping
0.1 seconds. Set object for a mesh target, scroll for shared progress, or write
current yourself. update(delta) returns true, and emits change, only when the camera
or mesh moved. focus accepts a world point or live mesh. loop: false clamps
endpoints. Use one owner for a camera/mesh transform; do not attach orbit and path
controls to the same camera at once. Dispose controls to remove listeners/update
plugins; paths and product meshes remain caller-owned.

```ts
import {Engine} from '@margoengine/core';
import {Spline} from '@margoengine/splines';
import {ScrollArea, ScrollControls, PathControls} from '@margoengine/controls/presentation';
const host = document.body.appendChild(document.createElement('div'));
host.style.cssText = 'width:480px;height:320px';
const canvas = host.appendChild(document.createElement('canvas'));
canvas.width = 480; canvas.height = 320;
const engine = await Engine.create(canvas);
const area = new ScrollArea(canvas, {pages: 3});
area.content.textContent = 'Scroll to travel along the path';
const scroll = new ScrollControls(engine, {element: area.element, damping: 0});
const spline = new Spline([[0, 1, 5], [2, 2, 4], [4, 1, 2]]);
const point = new Float64Array(3);
const curve = {
  length: spline.length,
  at: (t: number) => {spline.at(t, point); return point;},
  atDistance: (distance: number) => {spline.atDistance(distance, point); return point;},
};
const path = new PathControls(engine, curve, {scroll, loop: false, focus: [0, 0, 0]});
scroll.setProgress(0.5, true);
path.update(1);
console.log(scroll.range(0.25, 0.5), scroll.curve(0.25, 0.5), scroll.visible(0.25, 0.5));
engine.render();
path.dispose(); scroll.dispose(); area.dispose(); engine.dispose(); host.remove();
```

## Device look: optional /device-orientation

DeviceOrientationControls uses the window's deviceorientation sensor events by
default, with screen-orientation compensation. Sensor angles are degrees; alphaOffset
is a world-up yaw in radians (default 0). smoothTime defaults 0.1 seconds, with 0
applying samples immediately. relative defaults true: the first sample aligns to the
current camera. recenter() aligns the next sample again. relative: false uses the
sensor reference directly. permission is prompt, granted, denied or unsupported;
absolute reports the latest event's reference mode. Null/nonfinite samples are ignored.

Serve from a secure context on sensor-capable hardware. Call requestPermission from
a real user gesture, before unrelated awaits. It resolves to a granted boolean and
defaults to a 10000 ms timeout; timeout or signal abort rejects and prevents late
activation. A denied/unsupported sensor does not move the camera. Disconnect/dispose
cancels a pending permission operation, removes listeners and releases its update
plugin. A source may be injected for deterministic event replay; such a replay does
not prove hardware permissions or phone/headset behavior.

```ts
import {Engine} from '@margoengine/core';
import {DeviceOrientationControls} from '@margoengine/controls/device-orientation';
const canvas = document.body.appendChild(document.createElement('canvas'));
const engine = await Engine.create(canvas);
const controls = new DeviceOrientationControls(engine, {smoothTime: 0.1});
const controller = new AbortController();
const button = document.body.appendChild(document.createElement('button'));
button.textContent = 'Enable device look';
button.addEventListener('click', () => {
  void controls.requestPermission({signal: controller.signal, timeout: 10000})
    .then(granted => {button.textContent = granted ? 'Device look enabled' : 'Sensor unavailable';})
    .catch(error => {button.textContent = String(error);});
});
engine.start(); // Keep the page alive for the user gesture and sensor updates.
addEventListener('pagehide', () => {
  controller.abort(); controls.dispose(); engine.dispose(); button.remove(); canvas.remove();
}, {once: true});
```

## Core compatibility and composed scenes

The package build records its required core version. Attaching a control checks the
engine's local core registry before accessing runtime state. A mismatched version
or a second core module instance throws a coded version error linking to
https://margoengine.com/errors#version. Resolve all packages to the same verified
core build; rebuilding/reinstalling aligned packages fixes the cause. There is no
global registry and importing a control does not attach it.

Works with the [J6 game composition](../../docs/integration-everything.md) and the
[public CAD-format viewer](../../docs/integration-engineering.md), whose documented
fixtures check device restoration and disposal on WebGPU and WebGL2 compatibility.
The viewer exercises orthographic navigation profile attachment, not every gesture.
