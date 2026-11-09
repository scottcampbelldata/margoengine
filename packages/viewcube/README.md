# @margoengine/viewcube

Import `margoengine/viewcube` from the `margoengine` package, or `@margoengine/viewcube` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

A CAD orientation cube for Margo Engine: a small cube in a corner of the view that turns with the camera. Click a face,
edge or corner and the camera animates around its target to that view (Top, Front, Right, ..., the twelve edge views
and the eight isometric corners), keeping the distance. With `@margoengine/cameras` it also toggles perspective and
orthographic projection.

```ts
import {Engine} from 'margoengine/core';
import {CameraProjection} from 'margoengine/cameras';
import {OrbitControls} from 'margoengine/controls';
import {ViewCube} from 'margoengine/viewcube';
const canvas = document.querySelector('canvas')!;

const engine = await Engine.create(canvas);           // the canvas needs a parent element; the cube is placed in it
const projection = CameraProjection.attach(engine, {mode: 'perspective'});
OrbitControls.attach(engine);                             // or the stage's CADCameraControls
const cube = ViewCube.attach(engine, {projection});       // omit projection to hide the toggle

cube.view('top');                                      // 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso'
cube.view([1, 1, 0]);                                  // any direction from the target toward the camera
cube.view('front', 0);                                 // jump without animating
cube.setProjection('orthographic');
cube.drag = false;                                     // dragging the cube orbits the camera unless turned off
cube.setHome({position: [6, 4, 8], target: [0, 1, 0]}); // your own home view; shows the home button
cube.home();                                           // the home button and the Home key do the same
cube.dispose();                                        // engine.dispose() also disposes it
```

Options: `container` (default: the canvas's parent; made `position: relative` if it is static), `corner`
(`'top-right'` default, `'top-left'`, `'bottom-right'`, `'bottom-left'`), `size` (cube edge in CSS pixels, 80),
`duration` (seconds, 0.4), `projection` (a CameraProjection, or anything with `mode`), `labels` (face names, for
translation), `flip` (false; also a public field: clicking the view already shown turns to the opposite one, as
Blender's navigation gizmo and SolidWorks' "Normal To" pressed twice do; Autodesk's ViewCube keeps the view),
`drag` (true; also a public field: dragging the cube orbits the camera), `home` (none; a `{position, target}`, or
`true` for the camera as it is when the cube attaches: shows the home button).
`@margoengine/controls` navigation profiles carry it: `ViewCube.attach(engine, {...BLENDER.viewCube})`. The toggle
also follows projection changes made elsewhere (Blender's numpad 5 through a profile) on the next frame.
`cube.element` is the widget root for your own styling.

- **Orientation.** World Y is up, front is +Z, right is +X (glTF and Blender exports). Top shows X right and -Z up,
  bottom X right and +Z up, from whichever side the camera comes, because the animation interpolates azimuth and
  elevation the way OrbitControls moves. Top and bottom are exactly vertical: on the pole the cube sets `camera.up` to
  the screen up of the way it came (arrow keys turn it there) and puts the previous up back as soon as the camera
  leaves the pole, or on `dispose` (then 1e-6 rad off the pole, same image). An up it did not set is left alone, such as
  a CameraProjection's vertical `up`. OrbitControls and CADCameraControls leave an exact pole at azimuth 0, so after a
  top view reached from the side they start from the front.
- **Drag to orbit.** Press on the cube and drag: the camera orbits its target at the same distance, with the
  azimuth and elevation OrbitControls uses, so the cube's surface follows the pointer (half the cube's width is one
  radian). Dragging right turns the front to the right; dragging down tips the top toward you and stops on the pole
  in a standard top view. A press that moves under 3 pixels is still a click on the face, edge or corner, and the
  click that ends a drag does nothing. The cube keeps the pointer while dragging, a drag cancels a view animation,
  and only the primary button drags (`touch-action: none` on the widget, so a touch drag does not scroll the page).
- **Home view.** `home` or `cube.setHome(view)` sets the app's own home: a camera position and the target it looks
  at (`cube.setHome()` takes the camera as it is now). A round home button appears at the cube's top-left corner;
  it and the Home key animate the camera there, moving the target and the distance too, and land on them exactly.
  A vertical home is exactly vertical with the standard top or bottom orientation. `cube.getHome()` returns a copy;
  without a home, Home goes to the isometric view and there is no button. A press on the button never starts a drag.
- **Engine views.** `ViewCube.attach(engine, {view: {camera, viewport}})` turns that view's camera and sits in the chosen corner of its rectangle (the cube's container must cover the canvas). One cube per view.
- **Controls.** The cube writes `camera.position` (and `camera.up` on the poles); OrbitControls, MapControls and the stage's CADCameraControls read
  the camera each frame, so they keep working. Any other camera change during an animation (a drag, a wheel) cancels it.
  A running `fitToBoundingBox` animation is cancelled when a view starts.
- **Accessibility.** The root is a labelled group. The six faces are buttons named "Front view", "Top view", ...; only
  faces turned toward the viewer are in the tab order (screen readers reach all six). Arrow keys step the view 45°
  around and over the target, Home goes to the home view (the isometric view without one), Enter or Space activates the focused face. Edge and
  corner hot spots are pointer targets with tooltips. The projection toggle is a button with `aria-pressed`; the home button is named "Home view".
- **Rendering.** Plain DOM and CSS 3D transforms: no GPU work, no extra pass, crisp text at any DPR, works on WebGPU
  and WebGL2. The cube turns in a frame-graph step after every control has moved the camera, so it never lags a frame,
  and touches the DOM only when the orientation changed.

Why a separate package and not `@margoengine/controls`: the cube is a DOM widget that drives any camera controller
(including the stage's CADCameraControls, which does not use controls) and optionally `@margoengine/cameras`; keeping it
out leaves controls' bundle and dependencies unchanged.

Limits: no roll (the cube sets `camera.up` only on the poles), the home view keeps the camera's field of view and
projection (only position and target), and the colours are fixed light-grey (restyle `.mvc-face` and `.mvc-projection`).

Size: 4,101 B min + gzip (the test enforces under 4,200 B). Apache-2.0. Peer: `@margoengine/core` (^0.1.0 || ^1.0.0).

Unit tests: `npm test --workspace @margoengine/viewcube`. Browser check with real clicks: `node packages/viewcube/test/browser-check.mjs`.
