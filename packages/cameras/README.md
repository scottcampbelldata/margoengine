# @margoengine/cameras

Orthographic projection and exactly vertical (top-down and bottom-up) views for core's camera, for CAD, plans, maps
and isometric views. Culling, `engine.pick`, selection, bvh rays, TAA and every pass that reads `camera.matrix` see the
same view. It uses core's `camera.project` and `camera.up` hooks.

```ts
import {Engine} from '@margoengine/core';
import {CameraProjection} from '@margoengine/cameras';

const engine = await Engine.create(canvas, {camera: {position: [0, 40, 0], target: [0, 0, 0]}}); // straight down
const projection = CameraProjection.attach(engine); // orthographic, framed like the perspective view at the target

projection.mode = 'perspective';             // toggle at any time; vertical views keep working
projection.mode = 'orthographic';
projection.height = 12;                      // or fix the visible world height (resize widens with the aspect)
projection.zoom = 2;
projection.fit(model.bounds);                // frame a box: [minX, minY, minZ, maxX, maxY, maxZ], animated
```

- **Fitting**: `fit(bounds, {aspect, duration, padding})` takes the flat bounds array models carry (no slicing into
  min/max). Orthographic: the view direction and distance stay, the box centre moves to the view centre and `zoom` is
  set so the box's projected outline (not a bounding sphere) fills the view less `padding` (default 1.1), honouring
  `height` or `left`/`right`/`top`/`bottom`. Perspective: core's `fitToBoundingBox`. `aspect` defaults to the engine
  canvas, `duration` to 0.3 s; the engine advances the animation (after `attach(camera)` call `onPreUpdate(delta)`
  yourself). Throws `Bounds exceed far` when the box does not fit the default depth range (`camera.far` deep).

- **Parameters** follow three.js `OrthographicCamera`: `left`, `right`, `top`, `bottom` (all four replace `height` and
  the canvas aspect, so update them on resize as in three.js), `zoom`, `near`, `far` (eye-space, may be negative).
  Without `height` or bounds the visible height is `2 · distance · tan(fov / 2)`: the perspective framing at the target,
  so `fitToBoundingBox`, core's `CADCameraControls` and `@margoengine/controls` dolly become ortho zoom and pan tracks
  the cursor exactly. Without `near`/`far` the depth range is `camera.far` deep and centred on the target (Blender's
  convention), so zooming in never clips a model at the eye.
- **Depth** is reversed-Z on WebGPU (near 1, far 0) like core, and -1..1 on WebGL. Orthographic depth is linear.
- **Vertical views**: core's `Camera.update` throws `Vertical camera` when the view is parallel to `camera.up`, which with the default +Y up means looking straight up or down. With the plugin,
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

Orthographic-aware (they read `camera.matrix`): SSAO, points, labels, clustered, DOF, splats and lines' world-space
widths. Shadow cascades are fitted to the perspective frustum, which covers
the default ortho view; a fixed small `height` far from the target wastes shadow resolution. Cascades stay texel-locked under orthographic pan and
zoom, with no visible shimmer: an ortho zoom leaves the shadow matrices unchanged, and a slow pan changes about 0.6 of
14k shadow-edge pixels per frame, against 194 for a 0.01° light turn (Intel Arc 140V laptop iGPU, Edge 155;
`examples/package-benchmarks/shadow-shimmer.mjs`, [shadow-shimmer.json](../../examples/package-benchmarks/results/shadow-shimmer.json)). Specular uses the camera
position, not a parallel view direction.

## Large coordinates: `@margoengine/cameras/origin`

Core and its transform kernel are float32, so a part 1 km from the world origin already shakes by ~0.7 px at
millimetre zoom, at 100 km by tens of pixels, and at Earth-radius scale it falls apart. `FloatingOrigin` keeps float64
world positions for root meshes on the CPU and hands core coordinates relative to an origin near the camera, moving
that origin (one full transform update of the placed roots) when the camera drifts too far. Measured: under 0.05 px
of jitter at any distance up to 6,000 km ([docs/large-coordinates.md](../../docs/large-coordinates.md)). 0 core bytes.

```ts
import {FloatingOrigin} from '@margoengine/cameras/origin';

const origin = FloatingOrigin.attach(engine);          // default ratio 1000
origin.place(flange, [2_880_000.12, 3_600_000.65, 3_840_000.31]); // float64 world metres; root meshes or model.root
origin.lookAt([2_880_000.15, 3_600_000.68, 3_840_000.35], [2_880_000.12, 3_600_000.65, 3_840_000.31]);
origin.worldPosition(flange);                          // float64 back
const hit = new Raycaster().setFromEngine(engine, x, y).intersectEngine(engine)[0];
origin.toWorld(hit.point);                             // pick point in float64 world coordinates
section.options.planes = [origin.toLocalPlane([0, 0, 1, -3_840_000.31])];
origin.onRebase(() => { section.options.planes = [origin.toLocalPlane(worldPlane)]; });
```

- **Local coordinates.** While attached, the camera, controls (`OrbitControls`, `CADCameraControls`, any that read
  `camera.position`/`target`), `engine.pick`, bvh hits, `mesh.matrix`, gltf-pro node matrices, section planes and
  measurements all work in local coordinates (world − `origin`). Convert at the boundary with `toWorld`, `toLocal` and
  `toLocalPlane`; `cameraPosition`/`cameraTarget` read the camera in world coordinates. Distances and angles between
  local points need no conversion.
- **Rebase rule.** Before each frame, when the camera is farther from the origin than `ratio` × its distance to
  `camera.target` (default 1000: 50 m at 50 mm zoom), the origin moves to the camera. Placed roots and the camera
  shift together; a running `fitToBoundingBox` animation is shifted too. Children follow their roots. `rebase(point)`
  forces one; `onRebase((shift, origin) => ...)` lets you shift data you hold in local coordinates (saved views,
  OrbitControls `saveState`, section planes, an orthographic `CameraProjection.fit` in flight).
- **Moving placed parts.** `place(mesh, world)` again, or move it through `mesh.position` (drag and transform gizmos,
  physics): the next rebase or `worldPosition` reads the new local position back.
- **Cost.** A rebase rewrites every placed root and makes the kernel recompute all of them and core re-upload their
  instances once (see the doc for 10k/50k timings); it is rare, since the camera must move ratio × view distance.
- **Limits.** Only root positions are float64. Geometry vertices and child (node) translations that are themselves
  kilometres from their root are float32 when loaded: re-centre such assets (or load each far part as its own root).
  `dispose()` leaves the scene in local coordinates.

MIT. Optional, tree-shakable package, about 1.7 kB min+gzip ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)); `/origin` is a separate entry of about 1.4 kB; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/cameras
