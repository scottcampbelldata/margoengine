# @margoengine/cameras

Orthographic projection and exactly vertical (top-down and bottom-up) views for core's camera, for CAD, plans, maps
and isometric views. Culling, `engine.pick`, selection, bvh rays, TAA and every pass that reads `camera.matrix` see the
same view; core is unchanged.

```ts
import {Engine} from '@margoengine/core';
import {CameraProjection} from '@margoengine/cameras';

const engine = await Engine.create(canvas, {camera: {position: [0, 40, 0], target: [0, 0, 0]}}); // straight down
const projection = new CameraProjection();  // orthographic, framed like the perspective view at the target
engine.use(projection);

projection.mode = 'perspective';             // toggle at any time; vertical views keep working
projection.mode = 'orthographic';
projection.height = 12;                      // or fix the visible world height (resize widens with the aspect)
projection.zoom = 2;
```

- **Parameters** follow three.js `OrthographicCamera`: `left`, `right`, `top`, `bottom` (all four replace `height` and
  the canvas aspect, so update them on resize as in three.js), `zoom`, `near`, `far` (eye-space, may be negative).
  Without `height` or bounds the visible height is `2 · distance · tan(fov / 2)`: the perspective framing at the target,
  so `fitToBoundingBox`, core's `CADCameraControls` and `@margoengine/controls` dolly become ortho zoom and pan tracks
  the cursor exactly. Without `near`/`far` the depth range is `camera.far` deep and centred on the target (Blender's
  convention), so zooming in never clips a model at the eye.
- **Depth** is reversed-Z on WebGPU (near 1, far 0) like core, and -1..1 on WebGL. Orthographic depth is linear.
- **Vertical views**: core's `Camera.update` throws `Vertical camera` when looking straight up or down. With the plugin,
  such a view renders exactly vertical with screen up = `up` (default `[0, 0, -1]`, north up looking down; it needs a
  horizontal component). The camera position is moved 1e-9 of the distance off vertical, on the side that gives the
  same orientation, so code that rebuilds a view from `position`/`target` (shadows, SSAO, gltf-pro, controls) keeps
  working. Orbit controls stay 1e-6 rad from the pole, so orbiting never snaps the roll.
- **Culling** is exact and stays on: the plugin replaces the camera's `update` and writes the culling planes with
  core's own extraction, and the engine copies them to the culling kernel right after. No `culling: false` and no
  extra cost; the projection adds one 4×4 product per frame.
- **Detecting it**: `camera.matrix` is orthographic when entries 3, 7 and 11 are zero.
- `attach(camera)` drives a camera without an engine; `dispose()` (or `engine.removePlugin('cameras')`) restores core.

Not orthographic-aware yet (they assume `fov`): SSAO's reconstruction, lines and points world-space sizes, labels'
CSS perspective, clustered froxels, DOF and splats. Shadow cascades are fitted to the perspective frustum, which covers
the default ortho view; a fixed small `height` far from the target wastes shadow resolution. Specular uses the camera
position, not a parallel view direction.

MIT. Optional, tree-shakable package, about 1.6 kB min+gzip; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/cameras
