# @margoengine/viewcube

A CAD orientation cube for Margo Engine: a small cube in a corner of the view that turns with the camera. Click a face,
edge or corner and the camera animates around its target to that view (Top, Front, Right, ..., the twelve edge views
and the eight isometric corners), keeping the distance. With `@margoengine/cameras` it also toggles perspective and
orthographic projection.

```ts
import {Engine} from '@margoengine/core';
import {CameraProjection} from '@margoengine/cameras';
import {OrbitControls} from '@margoengine/controls';
import {ViewCube} from '@margoengine/viewcube';

const engine = await Engine.create(canvas);           // the canvas needs a parent element; the cube is placed in it
const projection = new CameraProjection({mode: 'perspective'});
engine.use(projection);
new OrbitControls(engine);                             // or core's CADCameraControls
const cube = new ViewCube(engine, {projection});       // omit projection to hide the toggle

cube.view('top');                                      // 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso'
cube.view([1, 1, 0]);                                  // any direction from the target toward the camera
cube.view('front', 0);                                 // jump without animating
cube.setProjection('orthographic');
cube.dispose();                                        // engine.dispose() also disposes it
```

Options: `container` (default: the canvas's parent; made `position: relative` if it is static), `corner`
(`'top-right'` default, `'top-left'`, `'bottom-right'`, `'bottom-left'`), `size` (cube edge in CSS pixels, 80),
`duration` (seconds, 0.4), `projection` (a CameraProjection, or anything with `mode`), `labels` (face names, for
translation). `cube.element` is the widget root for your own styling.

- **Orientation.** World Y is up, front is +Z, right is +X (glTF and Blender exports). Top shows X right and -Z up,
  bottom X right and +Z up, from whichever side the camera comes, because the animation interpolates azimuth and
  elevation the way OrbitControls moves. Top and bottom are exactly vertical: on the pole the cube sets `camera.up` to
  the screen up of the way it came (arrow keys turn it there) and puts the previous up back as soon as the camera
  leaves the pole, or on `dispose` (then 1e-6 rad off the pole, same image). An up it did not set is left alone, such as
  a CameraProjection's vertical `up`. OrbitControls and CADCameraControls leave an exact pole at azimuth 0, so after a
  top view reached from the side they start from the front.
- **Controls.** The cube writes `camera.position` (and `camera.up` on the poles); OrbitControls, MapControls and core's CADCameraControls read
  the camera each frame, so they keep working. Any other camera change during an animation (a drag, a wheel) cancels it.
  A running `fitToBoundingBox` animation is cancelled when a view starts.
- **Accessibility.** The root is a labelled group. The six faces are buttons named "Front view", "Top view", ...; only
  faces turned toward the viewer are in the tab order (screen readers reach all six). Arrow keys step the view 45°
  around and over the target, Home goes to the isometric view, Enter or Space activates the focused face. Edge and
  corner hot spots are pointer targets with tooltips. The projection toggle is a button with `aria-pressed`.
- **Rendering.** Plain DOM and CSS 3D transforms: no GPU work, no extra pass, crisp text at any DPR, works on WebGPU
  and WebGL2. The cube turns in a frame-graph step after every control has moved the camera, so it never lags a frame,
  and touches the DOM only when the orientation changed.

Why a separate package and not `@margoengine/controls`: the cube is a DOM widget that drives any camera controller
(including core's CADCameraControls, which does not use controls) and optionally `@margoengine/cameras`; keeping it
out leaves controls' bundle and dependencies unchanged.

Limits: no drag-to-orbit on the cube itself, no roll (the cube sets `camera.up` only on the poles), no "home" view of your own (use
`camera.fitToBoundingBox`), and the colours are fixed light-grey (restyle `.mvc-face` and `.mvc-projection`).

Size: 3.1 kB min + gzip (the test enforces under 3.5 kB). MIT. Peer: `@margoengine/core` (^0.1.0 || ^1.0.0).

Unit tests: `npm test --workspace @margoengine/viewcube`. Browser check with real clicks: `node packages/viewcube/test/browser-check.mjs`.
