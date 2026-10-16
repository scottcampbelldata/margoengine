# @margoengine/controls

`stepLocomotion(state, actions, delta, height, options?)` provides ground-following
character movement with normalized diagonals, damped speed and heading, and a
50 ms movement-step limit. Retained state is `[x,y,z,heading,cameraYaw,cameraPitch,
gaitPhase,speed]`; actions are `[strafe,forward,lookX,lookY,sprint]`.
Options include `bounds: [minX,maxX,minZ,maxZ]`, `minHeight`, `walkSpeed` (3.4),
and `runSpeed` (7). Bounds and minimum height are omitted by default. Look values
are angular deltas; pitch stays between -1.4 (look up) and 0.9 radians (look down).
Use `Cinematic` ground clearance to keep upward-looking cameras above terrain. Height samples must
be finite. The caller owns input bindings, character meshes and gait animation.

Orbit, map, trackball, fly, first-person and pointer-lock camera controls plus an interactive transform gizmo and drag controls for Margo Engine, each tree-shakable on its own. `DragControls` uses `@margoengine/bvh` (a peer dependency) for its hits.

Build from source with `npm run build` in `packages/controls`.

```ts
import {Engine, box} from '@margoengine/core';
import {OrbitControls, TransformControls} from '@margoengine/controls';

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

Drag core meshes and gltf-pro models (a model moves by its `root`), with the mouse or touch:

```ts
import {Engine, box} from '@margoengine/core';
import {DragControls, OrbitControls} from '@margoengine/controls';
import {loadGLTF} from '@margoengine/gltf-pro';

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

## Walkthroughs and simple games: `@margoengine/controls/walk`

`WalkControls` is a Wasm-free kinematic first-person walker: eye height held above the floor, stairs, slopes, walls,
glass, jump and crouch, keyboard + mouse, gamepad and touch, and an orbit "dollhouse" view and back. It collides on the
CPU against the cached triangle trees of the `@margoengine/bvh` Raycaster (core meshes, gltf-pro and materials models),
so it costs nothing unless you import its entry. A whole recipe: [docs/guides/walkthrough.md](../../docs/guides/walkthrough.md).

```ts
import {Engine} from '@margoengine/core';
import {loadGLTF} from '@margoengine/gltf-pro';
import {WalkControls} from '@margoengine/controls/walk';

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
  floors it crosses. Gaps narrower than about 1.66 × the radius (0.41 m by default, in any direction) are stepped over.
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
- **Limits.** Static levels (colliders use the last frame's matrices; moving platforms do not carry the walker);
  skinned meshes collide in their bind pose; on slopes the ring can hold the eye up to 0.9 × radius × the slope's
  tangent higher; a primitive's tree is built synchronously the first time the walker comes near it
  (`computePrimitiveBVHAsync` builds them in a worker beforehand). For rigid bodies, joints and vehicles use
  `@margoengine/physics` (Rapier).

Without an engine, pass a `Camera` and an element and drive the controls yourself: `const fly = new FlyControls(camera, canvas); engine.onFrame((_, delta) => fly.update(delta));`.

`OrbitControls.update()` reuses its camera vectors during continuous updates. Copy `camera.position` and `camera.target` when taking a snapshot.

## Controls

| Class | Replaces (three.js) | Input |
| --- | --- | --- |
| `OrbitControls` | `OrbitControls` | Left drag rotates, middle drag or wheel dollies, right drag (or shift/ctrl + left) pans, arrows pan after `listenToKeyEvents(target)`. One finger rotates, two fingers dolly and pan. |
| `MapControls` | `MapControls` | Left drag pans along the ground, right drag rotates, two fingers dolly and rotate. |
| `TrackballControls` | `TrackballControls` | Left rotates freely, middle zooms, right pans; hold A, S or D to switch the left button. Coasts with `dynamicDampingFactor`. |
| `FlyControls` | `FlyControls` | WASD moves, R/F up and down, arrows yaw and pitch, pointer offset from center steers (or `dragToLook`). |
| `FirstPersonControls` | `FirstPersonControls` | Pointer offset from center turns, WASD or arrows move, R/F up and down, left/right button walks. |
| `PointerLockControls` | `PointerLockControls` | `lock()` from a click, mouse look while locked, WASD/arrows/R/F through `update(delta)`, plus `moveForward`, `moveRight`, `moveUp`. |
| `TransformControls` | `TransformControls` | Translate (axis arrows, plane squares, center screen-plane handle), rotate (axis rings, view ring, free trackball disc), scale (axis handles, uniform center). |
| `WalkControls` (`/walk`) | (three.js has none; its examples use Octree capsules) | WASD/arrows, mouse look (pointer lock or drag), gamepad sticks, touch thumbstick + drag-look; collides with the scene, holds eye height, climbs stairs. |
| `DragControls` | `DragControls` | Left button or one finger grabs the nearest listed core mesh or gltf-pro model and moves it on the view plane, a world plane (`plane`) or a world axis (`axis`). Mouse hover reports the object under the pointer. |

Every control has `enabled`, `connect(element)`, `disconnect()`, `update(delta)` (returns true when the camera moved), `dispose()` and three.js-style `addEventListener`. Camera controls emit `change`, and the drag-based ones `start` and `end`. `PointerLockControls` emits `lock` and `unlock`. `TransformControls` emits `change`, `mouseDown`, `mouseUp`, `objectChange`, `dragging-changed` (`value`), `axis-changed` (`value`), `mode-changed` and `space-changed`. `DragControls` emits `dragstart` (`object`, `hit`), `drag`, `dragend`, `hoveron` and `hoveroff` (each with `object`).

`DragControls` casts the pointer ray with a bvh `Raycaster` (`setFromEngine`, then `intersectObjects` on its `objects`), so it follows layers, `filter` and material sides, and works with orthographic cameras from @margoengine/cameras, whose rays start on the near plane. The drag plane passes through the grabbed point; with `axis` it contains the axis and faces the camera as far as it can. Each move intersects the new pointer ray with that plane and sets the object's position in its parent's space, so parented meshes follow the pointer. A grab stops later pointer-down listeners on the element and captures the pointer; touch uses the primary pointer and ignores other fingers. Pass your own `raycaster` to share layers and filters.

## Navigation profiles

Engineers get the mouse, wheel, touch and keys of the tool they know, in one call:

```ts
import {Engine} from '@margoengine/core';
import {OrbitControls, SOLIDWORKS} from '@margoengine/controls';
import {CameraProjection} from '@margoengine/cameras';
import {ViewCube} from '@margoengine/viewcube';

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
controls, so options set afterwards (`enableDamping`, `zoomSpeed`, `zoomToCursor`) still win. `THREE_ORBIT` (the default,
also what a fresh OrbitControls does) restores three.js behaviour. Each profile is its own export, so an app bundles only
the one it imports (OrbitControls + one profile: +171 B gzip); `PROFILES` (all nine by name, for a preferences menu,
+427 B) is there when you want the choice at run time. Write your own the same way: `orbit.setProfile({...BLENDER,
zoomToCursor: true})`.

Why a method and data, not `attach(engine, {profile: 'solidworks'})`: `attach` mirrors the constructor (engine, element)
like every other control, a string name would pull every profile into every bundle, and `setProfile` also switches
tools at run time from a preferences menu. `fit` is an event because only the app knows what to fit (the selection, the
whole model, a CameraProjection or a perspective `camera.fitToBoundingBox`).

| Profile | Rotate | Pan | Zoom drag | Wheel (forward = away from you) | Fit | Touch (1 finger / 2) | Keys | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `THREE_ORBIT` (default) | Left; Ctrl/Meta/Shift + right | Right; Ctrl/Meta/Shift + left | Middle | In, toward the target | - | Rotate / pinch + pan | Arrows pan, Ctrl/Shift + arrows rotate | three.js docs and source, `OrbitControls` |
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
finger; Blender, Maya, Onshape and Rhino have no first-party touch defaults here, so they use the three.js one.
Every profile keeps three.js arrow keys and `TOUCH` constants; mouse buttons a profile leaves unbound (left in most CAD
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
`OrbitControls` and `MapControls`; core's `CADCameraControls` (used by the stage facade) hard-codes left orbit, other
buttons or Shift pan, wheel zoom, and core is frozen, so it takes no profile: use `OrbitControls.attach(engine)` instead.
Under an orthographic `@margoengine/cameras` projection the wheel and dolly drags change the visible height (ortho zoom)
about the cursor when the projection's `height` is left at its default (perspective height at the target); with an
explicit `height` they change only the distance.

## How it works

- **Camera model.** The Margo Engine `Camera` is a position, a target, `fov`, `near`, `far` and an `up` vector (default world +Y). All controls write `camera.position` and `camera.target` and nothing else. `OrbitControls.target` reads and writes `camera.target`. The core camera rejects a view parallel to its `up`, so with the default +Y every control keeps the view at least a hair off the poles (orbit uses an epsilon on the polar angle, the walk controls cap pitch just under 90 degrees).
- **Roll.** These controls keep world +Y up and do not roll (core's `camera.up` exists, but they don't drive it; on an exact pole, such as a ViewCube top view, OrbitControls reads its heading from `camera.up`). `TrackballControls` computes its rotation axis from the rendered frame (screen right and up derived from +Y), drops the roll that three.js would apply to `camera.up`, and stops the eye just short of a pole instead of tumbling over it, which would flip the image. `FlyControls` ignores Q and E (roll) and yaws around world +Y. Roll could be built on `camera.up`; not done yet.
- **Damping.** three.js damps per frame. Here the factors are applied per 1/60 s (`1 - (1 - factor)^(delta * 60)`), so 30 and 60 fps settle identically. Without damping, pointer input is applied immediately.
- **Zoom to cursor.** The dolly is a scaling about the point under the cursor on the plane through the target facing the camera, so the view direction is unchanged and that point keeps its pixel exactly.
- **Engine integration.** Constructed with an engine, a control registers a small plugin whose `onPreUpdate` calls `update(delta)` before each render, and `engine.dispose()` disposes it. Rendering manually with `engine.render()` passes `delta = 0`, which still applies direct input but does not advance damping, auto-rotate or key movement; pass `{delta}` to advance them.
- **Listeners.** Pointer listeners go on the canvas (or the element you pass), using pointer capture. Keyboard listeners for the trackball, fly, first-person and pointer-lock controls go on the element's `ownerDocument` unless you pass `{keyTarget}`. Nothing is touched at import time and construction only touches the element you give it, so modules are SSR-safe. `dispose()` removes every listener and restores `touch-action`.
- **Gizmo rendering.** `TransformControls` builds its handles on the CPU each frame (lines, cones, cubes, squares, rings), keeping a constant screen size with the three.js formula (under an orthographic camera from @margoengine/cameras: the same fraction of the view height at any `zoom` or `height`, with parallel-ray picking and drags). A frame graph pass (order 1000) turns lines into screen-space quads, sorts triangles back to front and draws them with alpha blending over the finished frame, with no depth test against the scene. It uses WebGPU when the engine does, and a tiny WebGL2 program on the fallback backend.
- **Gizmo picking.** Hit tests are CPU-only in CSS pixels: arrows, scale axes and rings by pixel distance to their projection (back halves of rings lose ties), plane squares by a ray-plane intersection, center and view-ring handles by projected circles. Axes pointing at the camera and planes seen edge-on are hidden and unpickable, as in three.js.
- **Gizmo dragging.** Translate intersects the cursor ray with a plane through the handle (the axis plane most facing the camera, the handle plane, or the view plane), projects the offset onto the axis, and writes `inverse(parentWorld) x newWorld` as the local position, so parented meshes follow the cursor exactly. Rotation is the signed angle between the grab and current points on the ring plane (falling back to a screen tangent drag when the ring is edge-on), applied as `P^-1 R P` to the local quaternion, where P is the parent's world rotation. Scale is always local, as in three.js: the ratio of current to grab distance along the handle axis, or one handle length of drag up or right doubles the uniform scale. World matrices come from `engineRuntime(engine).store.matrices`. The gizmo stops the pointerdown event from reaching later listeners when it grabs a handle, and emits `dragging-changed` so you can disable `OrbitControls`.

## Options

| Option | Control | Default |
| --- | --- | --- |
| `enableDamping`, `dampingFactor` | Orbit, Map | `false`, `0.05` |
| `rotateSpeed`, `zoomSpeed`, `panSpeed` | Orbit, Map | `1`, `1`, `1` |
| `minDistance`, `maxDistance` | Orbit, Map, Trackball | `0`, `Infinity` |
| `minPolarAngle`, `maxPolarAngle` | Orbit, Map, PointerLock | `0`, `PI` |
| `minAzimuthAngle`, `maxAzimuthAngle` | Orbit, Map | `-Infinity`, `Infinity` |
| `zoomToCursor`, `screenSpacePanning`, `keyPanSpeed` | Orbit, Map | `false`, `true` (`false` for Map), `7` px |
| `autoRotate`, `autoRotateSpeed` | Orbit, Map | `false`, `2` (one turn per 30 s) |
| `mouseButtons`, `touches`, `keys` | Orbit, Map, Trackball | three.js defaults, using the exported `MOUSE` and `TOUCH` |
| `setProfile(profile)`, `profile` | Orbit, Map | `null` (three.js, same as `THREE_ORBIT`); see Navigation profiles |
| `rotateSpeed`, `zoomSpeed`, `panSpeed`, `staticMoving`, `dynamicDampingFactor`, `noRotate`, `noZoom`, `noPan` | Trackball | `1`, `1.2`, `0.3`, `false`, `0.2`, `false` |
| `movementSpeed`, `rollSpeed`, `dragToLook`, `autoForward` | Fly | `1`, `0.005`, `false`, `false` |
| `movementSpeed`, `lookSpeed`, `lookVertical`, `activeLook`, `heightSpeed`, `constrainVertical`, `verticalMin`, `verticalMax` | FirstPerson | three.js defaults |
| `pointerSpeed`, `movementSpeed`, `requireLock`, `keys` | PointerLock | `1`, `1`, `true`, WASD/arrows/R/F |
| `mode`, `space`, `size` | Transform | `'translate'`, `'world'`, `1` |
| `translationSnap`, `rotationSnap` (radians), `scaleSnap` | Transform | `null` |
| `showX`, `showY`, `showZ`, `visible`, `enabled` | Transform | `true` |
| `element`, `order` | Transform | engine canvas, `1000` |

## Limits

- No roll anywhere (see above). Trackball rotation therefore cannot pass over the poles.
- Orthographic cameras come from @margoengine/cameras (dolly becomes ortho zoom there; pan and the gizmo read the orthographic height from `camera.matrix`); orbit `zoom` of three.js is not implemented. `minTargetRadius`, `maxTargetRadius` and `cursor` from recent three.js `OrbitControls` are not implemented.
- `TransformControls` has no plane scale handles, does not flip arrows toward the camera, draws no start-to-current delta helper lines, and does not snap free (trackball) rotation. A parent with non-uniform scale and rotation shears its children; drags use the parent's rotation without the shear.
- The gizmo is always on top of the scene (no occlusion by scene geometry), like three.js by default.
- `ArcballControls` is not included. `DragControls` has no rotate mode, `recursive` or `transformGroup` options; pass a model to drag the whole model, or a core mesh to drag that mesh. Skinned models are grabbed in their bind pose (see @margoengine/bvh).

## Tests

`npm test` in `packages/controls` runs Node tests with synthetic pointer, wheel and keyboard events on a fake element, and real core `Camera`, `TransformStore` and `Engine` objects with a stub renderer: orbit azimuth and polar mapping, polar and azimuth clamping and pole safety, damping convergence at 30 and 60 fps, dolly limits, zoom to cursor keeping the world point on its pixel, screen-space and ground panning moving target and position equally, keyboard pan, touch rotate and pinch, `enabled`, `reset`, auto-rotate, map panning, trackball rotation, coasting and pole guard, fly and first-person movement and look, pointer-lock look limits and WASD helpers, and the gizmo: translating along an axis by a known screen drag, constant screen size, picking, drags and orbit pan under an orthographic camera at several zooms, snapping in world and local space, plane and screen handles, ring rotation following the cursor, rotation snapping, more than 180 degrees of rotation, the view ring and free rotation, axis and uniform scale with snapping, local versus world space, a parented mesh (translate, rotate, scale) under a rotated and scaled parent, hover highlighting, axis toggles, OrbitControls disabled during a gizmo drag, tessellation of every mode, and listener and plugin cleanup. Drag tests move a box under a scaled parent on the view plane (checked against an independent ray-plane intersection), along an axis and on the ground plane, a gltf-pro model by touch under an orthographic camera (600 CSS pixels for 6 world units), and check events, hover, misses falling through to later listeners, other fingers, disposed meshes and models, and cleanup.

`tests/walk.test.js` covers `WalkControls` on real core engines with generated geometry, at fixed time steps: a 12-step
stair of 0.18 m risers climbed and descended with the eye never jumping more than 6 cm a frame, 0.19 m climbed and 0.25 m
and 0.4 m refused; sliding along a wall at the radius; a zero-thickness glass pane and corner never crossed at 30 m/s
at 10, 30 and 60 frames per second; eye height within 2 mm over hardwood, a 12 mm rug and a deck with 1 cm gaps; a
0.35 m gap bridged and a 0.8 m gap fallen into; 20° and 40° ramps climbed, 60° blocked; no jump at the default
`jumpSpeed`, a jump's apex within 5 cm of v²/2g, one jump per press, a ceiling stopping the head, a 2 m fall landing;
crouching under a 1.3 m overhang and standing only past it; the generated two-storey house (`tests/house.js`) walked
from the deck through the door, over the rug, through the doorway and up 16 stairs to the upper floor with the capsule
never closer than its radius minus 1 cm to any box or the glass; the dollhouse view out and back (never vertical,
framed on the bounds, orthographic through a `CameraProjection`, an orbit drag, a `FloatingOrigin` rebase, a toggle
cancelled half way); a gltf-pro model wall, hidden models, explicit and changed collider lists; and keys, drag and
pointer-lock look, touch thumbstick and drag-look, a gamepad, and listener and plugin cleanup.
`npm run test:browser:walk` (real GPU, not in CI) walks the same house in Edge with the real W key, screenshots each
waypoint and the dollhouse, checks the capsule's clearance every frame and zero WebGPU errors, and drives the touch
thumbstick on a 390 × 844 phone viewport.

`tests/profiles.test.js` covers navigation profiles: a recorded sequence of mouse drags (every button and modifier),
wheel notches (pixel, line, page, Ctrl pinch, Shift, Alt), a double middle click, one- and two-finger touch and keys
(`tests/orbit-replay.json`, recorded from OrbitControls before profiles existed) replays to bit-identical camera
positions, targets, `preventDefault` flags, states and events with no profile, with `setProfile(THREE_ORBIT)` and after
switching from Blender back to it, plain, damped and with zoom to cursor; per profile, every bound and unbound
button/modifier gives the expected motion (rotate, pan, dolly in or none), the wheel direction, zoom to cursor, one finger
and pinch; double clicks (and not slow or moved ones) and fit keys dispatch `fit`; view keys snap (eased with damping);
Blender numpad 5 toggles a CameraProjection; under an orthographic projection the wheel is ortho zoom keeping the point
under the cursor, and Rhino right drag pans there; and the browser conflicts above (Alt keyup, context menu, middle
`mousedown`, Ctrl + wheel, browser shortcuts passing through). Re-record the replay only for an intended change:
`RECORD=1 node --test tests/profiles.test.js`.

`npm run test:browser` (a real-GPU script, not in CI) starts a real engine in Chromium (or Edge, honoring `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE` and `BROWSER_ARGS`) and drives it with `page.mouse`: an orbit drag moves the rendered box to its newly projected position, the wheel enlarges it, the gizmo draws over the mesh, hover turns the X arrow yellow, dragging the X arrow 100 px moves the mesh and the rendered box by the expected amount while the camera stays still, dispose removes every canvas listener and the overlay pass, there are zero WebGPU validation errors, and the WebGL2 backend draws and removes the same overlay. `npm run size` prints the gzip size of the whole bundle and of each control tree-shaken on its own.

MIT licensed.
