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
cube.setTheme('dark');                                 // 'light' | 'dark' | 'high-contrast' | 'auto' | your own tokens
cube.drag = false;                                     // dragging the cube orbits the camera unless turned off
cube.setHome({position: [6, 4, 8], target: [0, 1, 0]}); // your own home view; shows the home button
cube.home();                                           // the home button and the Home key do the same
cube.roll(1);                                          // a quarter turn counter-clockwise about the view axis (-1 clockwise)
cube.dispose();                                        // engine.dispose() also disposes it
```

For less than a cube, `margoengine/viewcube/axes` (`@margoengine/viewcube/axes`) has an axis triad: X, Y and Z
balls on sticks and a smaller ball at each negative end, turning with the camera.

```ts
import {Engine} from 'margoengine/core';
import {AxisTriad} from 'margoengine/viewcube/axes';
const canvas = document.querySelector('canvas')!;

const engine = await Engine.create(canvas);
const triad = AxisTriad.attach(engine, {corner: 'bottom-left', home: true}); // every ViewCube option works
triad.view('right');                                   // a ViewCube in every other way
```

Options: `container` (default: the canvas's parent; made `position: relative` if it is static), `corner`
(`'top-right'` default, `'top-left'`, `'bottom-right'`, `'bottom-left'`), `size` (cube edge in CSS pixels, 80),
`duration` (seconds, 0.4), `projection` (a CameraProjection, or anything with `mode`), `labels` (face names, for
translation), `flip` (false; also a public field: clicking the view already shown turns to the opposite one, as
Blender's navigation gizmo and SolidWorks' "Normal To" pressed twice do; Autodesk's ViewCube keeps the view),
`drag` (true; also a public field: dragging the cube orbits the camera), `home` (none; a `{position, target}`, or
`true` for the camera as it is when the cube attaches: shows the home button), `roll` (false; shows the two roll
buttons), `theme` (none: the light colours; see Themes).
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
  at (`cube.setHome()` takes the camera as it is now). A round home button appears above the cube's top-left corner;
  it and the Home key animate the camera there, moving the target and the distance too, and land on them exactly.
  A vertical home is exactly vertical with the standard top or bottom orientation. `cube.getHome()` returns a copy;
  without a home, Home goes to the isometric view and there is no button. A press on the button never starts a drag.
- **Roll.** `roll: true` shows two round buttons above the cube's top-right corner that turn the view a quarter turn
  about its axis, counter-clockwise and clockwise; `cube.roll(turns)` does the same for any number of quarter turns
  and `cube.turns` reads the roll (0 to 3 at rest). The camera position and target stay; the cube rolls
  `camera.up` about the view axis again every frame, so the roll holds while OrbitControls or another control
  orbits, on the poles too, and a drag on a rolled cube still follows the pointer on screen. A view change from the
  cube (a face, edge or corner, the arrow keys, Home) turns the view upright again; an up set by someone else wins
  and ends the roll; `dispose` gives the app's up back. The buttons and the home button share a row above the cube,
  so a cube in a top corner sits 38 px from the edge instead of 12 px.
- **Themes.** The colours are six tokens, each a CSS custom property on the widget root: `--mvc-background` (face
  and button fill), `--mvc-text`, `--mvc-line` (edges and borders), `--mvc-hover` (fill of a hovered or focused face,
  edge, corner or button), `--mvc-hover-text` and `--mvc-focus` (keyboard focus ring). `THEMES` exports the built-in
  `light`, `dark` and `high-contrast` sets; `theme` or `cube.setTheme(...)` takes one of their names, `'auto'`
  (dark when the browser prefers a dark scheme, high contrast when it prefers more contrast, else light) or your own
  tokens, for example `cube.setTheme({background: '#1b1f27', text: '#f2f4f7'})`; tokens you leave out keep the
  stylesheet's. Without a theme the cube sets no inline colours, so your own CSS can set the properties on `.mvc`.
  The package tests check every built-in pair against WCAG 2 contrast over both a black and a white page behind the
  translucent fill: text and hovered text at least 4.5:1 (high contrast 7:1), edges and the focus ring at least 3:1.
  The light theme's edges and focus ring are darker than before themes (`#6b7280`, `#0b3d91`) for that reason.
- **Axis triad.** `AxisTriad` (entry `viewcube/axes`) is a `ViewCube` subclass that builds balls in place of the
  faces: +X, +Y and +Z are buttons labelled X, Y and Z ("Right view (X)", "Top view (Y)", "Front view (Z)"), the
  negative ends smaller rings. Each ball sits where its axis points on screen, nearer balls drawn in front, so the
  view is read the way a CAD axis gizmo reads. Clicking a ball animates to that axis view, dragging orbits (two
  radians per triad width), and the home view, roll buttons, projection toggle, themes, flip and keyboard behave as
  on the cube. Default `size` is 64. The axis colours are `--mvc-x`, `--mvc-y` and `--mvc-z` (default `#c62828`,
  `#2e7d32`, `#1565c0`, white letters at 4.5:1 or more). The cube's `build` and `draw` are the protected hooks it
  overrides.
- **Engine views.** `ViewCube.attach(engine, {view: {camera, viewport}})` turns that view's camera and sits in the chosen corner of its rectangle (the cube's container must cover the canvas). One cube per view.
- **Controls.** The cube writes `camera.position` (and `camera.up` on the poles); OrbitControls, MapControls and the stage's CADCameraControls read
  the camera each frame, so they keep working. Any other camera change during an animation (a drag, a wheel) cancels it.
  A running `fitToBoundingBox` animation is cancelled when a view starts.
- **Accessibility.** The root is a labelled group. The six faces are buttons named "Front view", "Top view", ...; only
  faces turned toward the viewer are in the tab order (screen readers reach all six). Arrow keys step the view 45°
  around and over the target, Home goes to the home view (the isometric view without one), Enter or Space activates the focused face. Edge and
  corner hot spots are pointer targets with tooltips. The projection toggle is a button with `aria-pressed`; the home button is named "Home view", the roll buttons "Roll the view counter-clockwise" and "... clockwise".
- **Rendering.** Plain DOM and CSS 3D transforms: no GPU work, no extra pass, crisp text at any DPR, works on WebGPU
  and WebGL2. The cube turns in a frame-graph step after every control has moved the camera, so it never lags a frame,
  and touches the DOM only when the orientation changed.

Why a separate package and not `@margoengine/controls`: the cube is a DOM widget that drives any camera controller
(including the stage's CADCameraControls, which does not use controls) and optionally `@margoengine/cameras`; keeping it
out leaves controls' bundle and dependencies unchanged.

Limits: roll is in quarter turns from the cube's buttons and `roll` (any whole or fractional count, landing on a
whole quarter turn), the home view keeps the camera's field of view and
projection (only position and target), and a custom theme's contrast is yours to check (only the built-in ones are
tested).

Size: 5,130 B min + gzip (the test enforces under 5,150 B); `viewcube/axes` adds 1,127 B on top (under 1,200 B). Apache-2.0. Peer: `@margoengine/core` (^0.1.0 || ^1.0.0).

Unit tests: `npm test --workspace @margoengine/viewcube`. Browser check with real clicks: `node packages/viewcube/test/browser-check.mjs`.
