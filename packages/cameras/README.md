# @margoengine/cameras

Orthographic projection and exactly vertical (top-down and bottom-up) views for core's camera, for CAD, plans, maps
and isometric views. Culling, `engine.pick`, selection, bvh rays, TAA and every pass that reads `camera.matrix` see the
same view. It uses core's `camera.project` and `camera.up` hooks.

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
  horizontal component). While attached, `camera.up` reads as `up` for such views (horizontal part at most 1e-9 of the
  distance) and as the world up (`[0, 1, 0]`) otherwise; assigning `camera.up` sets that world up. The position is
  not moved, and passes that rebuild the view (shadows, SSAO, gltf-pro) read `camera.up` too. Orbit controls stay
  1e-6 rad from the pole, so orbiting never snaps the roll.
- **Culling** is exact and stays on: core derives the culling planes from the matrix the `project` hook builds. No
  `culling: false` and no extra cost.
- **Detecting it**: `camera.matrix` is orthographic when entries 3, 7 and 11 are zero.
- `attach(camera)` drives a camera without an engine; `dispose()` (or `engine.removePlugin('cameras')`) restores core's
  `project` (unset) and a plain `up` field. Attaching to a camera whose `project` is already set throws.

Not orthographic-aware yet (they assume `fov`): SSAO's reconstruction, lines and points world-space sizes, labels'
CSS perspective, clustered froxels, DOF and splats. Shadow cascades are fitted to the perspective frustum, which covers
the default ortho view; a fixed small `height` far from the target wastes shadow resolution. Specular uses the camera
position, not a parallel view direction.

MIT. Optional, tree-shakable package, about 1.1 kB min+gzip; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/cameras
