# @margoengine/controls

`stepLocomotion(state, actions, delta, height, options?)` provides ground-following
character movement with normalized diagonals, damped speed and heading, and a
50 ms movement-step limit. Retained state is `[x,y,z,heading,cameraYaw,cameraPitch,
gaitPhase,speed]`; actions are `[strafe,forward,lookX,lookY,sprint]`.
Options include `bounds: [minX,maxX,minZ,maxZ]`, `minHeight`, `walkSpeed` (3.4),
and `runSpeed` (7). Bounds and minimum height are omitted by default. Look values
are angular deltas; pitch stays between 0.08 and 0.9 radians. Height samples must
be finite. The caller owns input bindings, character meshes and gait animation.

Orbit, map, trackball, fly, first-person and pointer-lock camera controls plus an interactive transform gizmo for Margo Engine, each tree-shakable on its own.

Not yet published to npm. Build from source with `npm run build` in `packages/controls`.

```ts
import {Engine, box} from '@margoengine/core';
import {OrbitControls, TransformControls} from '@margoengine/controls';

const canvas = document.createElement('canvas');
const engine = await Engine.create(canvas);
const mesh = engine.createMesh().setGeometry(box());

// Passing the engine attaches to engine.canvas and updates before every render.
const orbit = new OrbitControls(engine);
orbit.enableDamping = true;

const gizmo = new TransformControls(engine, {mode: 'translate', translationSnap: 0.25});
gizmo.attach(mesh);
gizmo.addEventListener('dragging-changed', event => {orbit.enabled = !event.value;});
addEventListener('keydown', event => {if (event.key === 'r') gizmo.setMode('rotate');});

engine.start();

// On teardown (engine.dispose() also disposes both):
gizmo.dispose(); orbit.dispose();
```

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

Every control has `enabled`, `connect(element)`, `disconnect()`, `update(delta)` (returns true when the camera moved), `dispose()` and three.js-style `addEventListener`. Camera controls emit `change`, and the drag-based ones `start` and `end`. `PointerLockControls` emits `lock` and `unlock`. `TransformControls` emits `change`, `mouseDown`, `mouseUp`, `objectChange`, `dragging-changed` (`value`), `axis-changed` (`value`), `mode-changed` and `space-changed`.

## How it works

- **Camera model.** The Margo Engine `Camera` is a position, a target, `fov`, `near` and `far`, always rendered with world +Y up. All controls write `camera.position` and `camera.target` and nothing else. `OrbitControls.target` reads and writes `camera.target`. The core camera rejects a view parallel to Y, so every control keeps the view at least a hair off the poles (orbit uses an epsilon on the polar angle, the walk controls cap pitch just under 90 degrees).
- **Roll.** The camera has no up vector, so it cannot roll. `TrackballControls` computes its rotation axis from the rendered frame (screen right and up derived from +Y), drops the roll that three.js would apply to `camera.up`, and stops the eye just short of a pole instead of tumbling over it, which would flip the image. `FlyControls` ignores Q and E (roll) and yaws around world +Y. If you need roll, it needs an up vector in core first.
- **Damping.** three.js damps per frame. Here the factors are applied per 1/60 s (`1 - (1 - factor)^(delta * 60)`), so 30 and 60 fps settle identically. Without damping, pointer input is applied immediately.
- **Zoom to cursor.** The dolly is a scaling about the point under the cursor on the plane through the target facing the camera, so the view direction is unchanged and that point keeps its pixel exactly.
- **Engine integration.** Constructed with an engine, a control registers a small plugin whose `onPreUpdate` calls `update(delta)` before each render, and `engine.dispose()` disposes it. Rendering manually with `engine.render()` passes `delta = 0`, which still applies direct input but does not advance damping, auto-rotate or key movement; pass `{delta}` to advance them.
- **Listeners.** Pointer listeners go on the canvas (or the element you pass), using pointer capture. Keyboard listeners for the trackball, fly, first-person and pointer-lock controls go on the element's `ownerDocument` unless you pass `{keyTarget}`. Nothing is touched at import time and construction only touches the element you give it, so modules are SSR-safe. `dispose()` removes every listener and restores `touch-action`.
- **Gizmo rendering.** `TransformControls` builds its handles on the CPU each frame (lines, cones, cubes, squares, rings), keeping a constant screen size with the three.js formula. A frame graph pass (order 1000) turns lines into screen-space quads, sorts triangles back to front and draws them with alpha blending over the finished frame, with no depth test against the scene. It uses WebGPU when the engine does, and a tiny WebGL2 program on the fallback backend.
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
- Margo Engine has no orthographic camera, so orbit `zoom` and the orthographic paths of three.js are absent; dolly is the only zoom. `minTargetRadius`, `maxTargetRadius` and `cursor` from recent three.js `OrbitControls` are not implemented.
- `TransformControls` has no plane scale handles, does not flip arrows toward the camera, draws no start-to-current delta helper lines, and does not snap free (trackball) rotation. A parent with non-uniform scale and rotation shears its children; drags use the parent's rotation without the shear.
- The gizmo is always on top of the scene (no occlusion by scene geometry), like three.js by default.
- `ArcballControls` and `DragControls` are not included.

## Tests

`npm test` in `packages/controls` runs 22 Node tests with synthetic pointer, wheel and keyboard events on a fake element, and real core `Camera`, `TransformStore` and `Engine` objects with a stub renderer: orbit azimuth and polar mapping, polar and azimuth clamping and pole safety, damping convergence at 30 and 60 fps, dolly limits, zoom to cursor keeping the world point on its pixel, screen-space and ground panning moving target and position equally, keyboard pan, touch rotate and pinch, `enabled`, `reset`, auto-rotate, map panning, trackball rotation, coasting and pole guard, fly and first-person movement and look, pointer-lock look limits and WASD helpers, and the gizmo: translating along an axis by a known screen drag, snapping in world and local space, plane and screen handles, ring rotation following the cursor, rotation snapping, more than 180 degrees of rotation, the view ring and free rotation, axis and uniform scale with snapping, local versus world space, a parented mesh (translate, rotate, scale) under a rotated and scaled parent, hover highlighting, axis toggles, OrbitControls disabled during a gizmo drag, tessellation of every mode, and listener and plugin cleanup.

`npm run test:browser` starts a real engine in Chromium (or Edge, honoring `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE` and `BROWSER_ARGS`) and drives it with `page.mouse`: an orbit drag moves the rendered box to its newly projected position, the wheel enlarges it, the gizmo draws over the mesh, hover turns the X arrow yellow, dragging the X arrow 100 px moves the mesh and the rendered box by the expected amount while the camera stays still, dispose removes every canvas listener and the overlay pass, there are zero WebGPU validation errors, and the WebGL2 backend draws and removes the same overlay. `npm run size` prints the gzip size of the whole bundle and of each control tree-shaken on its own.

MIT licensed.
