# @margoengine/cameras

Import `margoengine/cameras` from the `margoengine` package, or `@margoengine/cameras` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Orthographic projection and exactly vertical (top-down and bottom-up) views for core's camera, for CAD, plans, maps
and isometric views. Culling, `engine.pick`, selection, bvh rays, TAA and every pass that reads `camera.matrix` see the
same view. It uses core's `camera.project` and `camera.up` hooks.

```ts
import {Engine} from 'margoengine/core';
import {CameraProjection} from 'margoengine/cameras';
import type {PBRModel} from 'margoengine/gltf-pro';
declare const model: PBRModel;
const canvas = document.querySelector('canvas')!;

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

- **Parameters**: `left`, `right`, `top`, `bottom` (all four replace `height` and
  the canvas aspect, so update them on resize), `zoom` (divides the frustum about its centre), `near`, `far` (eye-space, may be negative).
  Without `height` or bounds the visible height is `2 · distance · tan(fov / 2)`: the perspective framing at the target,
  so `fitToBoundingBox`, core's `CADCameraControls` and `@margoengine/controls` dolly become ortho zoom and pan tracks
  the cursor exactly. Without `near`/`far` the depth range is `camera.far` deep and centred on the target (Blender's
  convention), so zooming in never clips a model at the eye.
- **Fixed size.** With an explicit `height` or all four bounds, `projection.fixedOrthographic` (also readable on the
  attached camera) is true: dolly changes only the distance, so `@margoengine/controls` zoom-to-cursor adds no pan.
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

Errors name their fix. Argument problems throw `RangeError` or `TypeError` (for example `Invalid fit; pass min <= max, aspect > 0, duration >= 0 and padding >= 1, all finite`). Branch on `error.code` for the rest: `attached` (a projection or camera already in use) and `state` (a `FloatingOrigin` used before `engine.use(origin)`).

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
import {FloatingOrigin} from 'margoengine/cameras/origin';
import {Engine} from 'margoengine/core';
declare const x: number;
declare const y: number;
const engine = await Engine.create(document.querySelector('canvas')!);

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

## Render layers: `@margoengine/cameras/layers`

Every mesh has a 32-bit layer mask (default 1, layer 0) and every camera or engine view draws only the meshes whose
mask shares a bit with its own. Core does the filtering while it collects instances, so nothing is hidden and
`mesh.visible` stays yours.

```ts
import {ALL_LAYERS, layerMask, setCameraLayers, setRenderLayers, withLayers} from 'margoengine/cameras/layers';
import {Engine, type Camera} from 'margoengine/core';
declare const top: Camera;
const engine = await Engine.create(document.querySelector('canvas')!);

setRenderLayers(helpers.root, layerMask(1));      // a model by its root: children without a mask follow it
setCameraLayers(engine.camera, layerMask(0));     // the engine camera now skips the helpers
engine.views = [
  {camera: engine.camera, viewport: [0, 0, 0.5, 1]},
  {camera: top, viewport: [0.5, 0, 0.5, 1], layers: ALL_LAYERS}, // this view shows the helpers too
];
mirror.layers = layerMask(0);                     // Reflector, Refractor and CubeCamera take a mask too
```

- **Masks**: `setRenderLayers(mesh, mask)` / `getRenderLayers(mesh)`; a mesh without its own mask takes its nearest
  ancestor's, else 1. `layerMask(...layers)` builds a mask from layer indices 0-31; `ALL_LAYERS` is every bit.
  `@margoengine/bvh` raycasts read the same masks (a mesh's own; a model primitive's node, else its root), so one
  `setRenderLayers` call filters both. `useLayerSource(fn)` makes drawing read masks from `fn` instead;
  `useLayerSource(null)` goes back. The masks live in one registry on `globalThis`, shared by every copy of this
  module and read by core and `@margoengine/environment`'s captures.
- **Cameras and views**: `setCameraLayers(camera, mask)` / `getCameraLayers(camera)` (default every layer). The engine
  frame, `engine.render({camera})` and every view through that camera use its mask; a view's own `layers` wins.
- **Scenes**: to show one set of meshes at a time, put each set on its own layer and switch the camera's mask (or the
  view's `layers`). Separate meshes, lighting and plugins are core scenes: `engine.createScene()`.
- **withLayers(engine, mask, run, exclude?)** hides the meshes outside `mask` and the `exclude` meshes for one callback
  (restored also when it throws): for a capture that must also leave out given meshes.
- **Limits**: masks with a layer source are re-read every frame; set masks are applied on the next frame. Raycasts keep
  bvh's own `raycaster.layers`. Unit tests: `test/layers.test.js` (real core on a mock GPU); real-GPU layer checks run
  in `scripts/env-mirror-gpu-check.js`.

## View offset: tiles, walls and jitter

`setViewOffset` renders one rectangle of a larger image. The frustum is built for the full image and the view shows only
the rectangle, in both modes, with any `zoom`, `height` or bounds. 0 core bytes.

```ts
import {CameraProjection, tileOffsets} from 'margoengine/cameras';
import {Engine} from 'margoengine/core';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);

const projection = CameraProjection.attach(engine, {mode: 'perspective'});
// A 8192 x 4608 screenshot from 2048 x 1152 tiles: size the canvas to a tile, then render each rectangle.
for (const t of tileOffsets(8192, 4608, 2048, 1152)) {
  projection.setViewOffset(t.fullWidth, t.fullHeight, t.x, t.y, t.width, t.height);
  engine.render();
  await copyTile(t, canvas); // read the pixels into your big image at (t.x, t.y)
}
projection.clearViewOffset();
```

- **Rectangle**: `setViewOffset(fullWidth, fullHeight, x, y, width, height)` in pixels of the full image, origin top
  left. `x` and `y` may be fractions or negative: a quarter-pixel step per frame is jittered rendering. `viewOffset` is
  also an option and a property.
- **Walls**: give each monitor its rectangle of the combined desktop (`fullWidth` the sum of widths).
- **Tiles**: `tileOffsets(fullWidth, fullHeight, tileWidth, tileHeight = tileWidth)` lists the rectangles row by row;
  edge tiles are smaller. Size the canvas to the tile; the aspect of the full image is used for the frustum.
- **Same view everywhere**: culling, `engine.pick`, and passes that read `camera.matrix` see the tile. `fit` still
  frames the canvas.
- **Limit**: passes that read neighbouring pixels (bloom, SSAO, DOF, TAA history) see only the tile, so seams can
  show; render tiles with overlap and crop. See [limits](../../docs/limits.md).

## Focal length and film gauge

Set the view the way photographers and Blender users do: a lens in millimetres on a sensor size, not a field of view.

```ts
import {CameraProjection, fovToLens, lensToFov} from 'margoengine/cameras';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

const projection = CameraProjection.attach(engine, {mode: 'perspective', focalLength: 50}); // 50 mm on a 36 mm sensor
projection.focalLength = 85;            // portrait lens; camera.fov follows each frame
projection.filmGauge = 24;              // sensor size in mm along sensorFit
projection.sensorFit = 'vertical';      // 'auto' (default: the longer image side), 'horizontal' or 'vertical'
lensToFov(35, 16 / 9);                  // vertical field of view in degrees for a 35 mm lens at 16:9
fovToLens(40, 16 / 9, {filmGauge: 36}); // the focal length that gives a 40 degree vertical field of view
```

- **Maths**: the field of view along the sensor axis is `2·atan(filmGauge / (2·focalLength))`, converted to the vertical
  axis by the image aspect. 50 mm on 36 mm is 39.6 degrees across the sensor's long side.
- **Sync**: with a `focalLength` set, the projection uses the lens in both modes (the default orthographic height too)
  and writes the vertical field of view to `camera.fov` every frame (`applyLens(aspect)` does it on demand), so
  shadows, controls and `fit` agree with it. Without one, `camera.fov` rules as before. With a view offset the lens
  is applied at the full image's aspect.
- **Errors**: `Invalid projection lens; ...` for a focal length, gauge or aspect that is not above 0 or an unknown
  `sensorFit`.

## Off-axis and oblique projection: `@margoengine/cameras/offaxis`

Head-tracked displays, CAVE walls and portals need a frustum that is not centred on the view axis. 0 core bytes.

```ts
import {ObliqueNearPlane, OffAxisProjection, offAxisFrustum, type Screen} from 'margoengine/cameras/offaxis';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

// A 1.2 x 0.7 m monitor standing on the desk at the origin, facing +z; corners counter clockwise from the viewer.
const screen: Screen = {lowerLeft: [-0.6, 0, 0], lowerRight: [0.6, 0, 0], upperLeft: [-0.6, 0.7, 0]};
const window = OffAxisProjection.attach(engine, screen, [0, 0.4, 0.8]);
tracker.onmove = (head) => window.setEye(head);     // world metres; the screen stays a window onto the scene

offAxisFrustum(screen, [0, 0.4, 0.8], 0.1);         // {left, right, bottom, top, xAxis, yAxis, normal, distance}

// Portals and mirrors: clip everything in front of a plane with no extra clip plane.
window.dispose();
const oblique = new ObliqueNearPlane([0, 0, -1, 0.5]).attach(engine.camera); // keeps z <= 0.5
oblique.plane = [0, -1, 0, 2];                      // change it every frame; undefined clips nothing
```

- **Off-axis**: `OffAxisProjection(screen, eye)` aims the camera straight into the screen from the eye and builds the
  asymmetric frustum from the three corners, so a point on the screen plane shows at the same place for any eye
  position, and anything behind it moves with parallax. The canvas aspect is ignored; size the canvas like the screen.
  Give each wall of a CAVE its own camera, view and `OffAxisProjection`. The eye must be in front of the screen;
  `camera.near` should not exceed the eye's distance to the screen or the screen's near corners are clipped.
- **Oblique**: `ObliqueNearPlane` replaces the near plane of the camera's projection with a plane in world space
  (`[nx, ny, nz, d]`, points with `n·p + d >= 0` are kept). It works with core's perspective camera, `CameraProjection`
  (orthographic too) and `OffAxisProjection`, on both depth conventions, and culling sees the same plane. Attach it
  last and `dispose()` it first. The camera must be on the clipped side; the oblique plane trades depth precision for the
  extra slant, so keep it away from edge-on views of the camera.
- `obliqueProjection(matrix, planeInEyeSpace, webgpu)` does the matrix part on its own.

## Physical exposure: `@margoengine/cameras/physical`

Aperture, shutter time and ISO set the exposure, the depth of field and the motion blur together, as on a real camera. 0 core bytes.

```ts
import {DOF} from 'margoengine/dof';
import {MotionBlur} from 'margoengine/post';
import {Tonemap} from 'margoengine/tonemap';
import {PhysicalCamera} from 'margoengine/cameras/physical';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

const camera = new PhysicalCamera({focalLength: 85, aperture: 1.8, shutter: 1 / 120, iso: 200, focusDistance: 3});
camera.apply({dof, motionBlur, exposure: tonemap, camera: engine.camera, aspect: 16 / 9}); // your DOF, MotionBlur and Tonemap effects
camera.aperture = 5.6;                  // stops down: darker, deeper focus
camera.apply({dof, motionBlur, exposure: tonemap});
camera.exposure;                        // stops against the reference: -1 at f/5.6, 1/120 s, ISO 200
camera.depthOfField();                  // {hyperfocal, near, far} in metres, far is Infinity past the hyperfocal distance
camera.blurDiameter(10);                // mm of blur on the sensor for a point 10 m away
```

- **Exposure**: `ev100 = log2(N² / t) − log2(ISO / 100)` for f-number N, shutter time t seconds. `exposure` is
  `referenceEV − ev100` in stops: a stop wider aperture, a doubled shutter time and a doubled ISO each add one. The
  engine's light is not calibrated in photometric units, so the reference decides what looks right: by default the
  defaults of `DOF` and `MotionBlur` (f/2.8, 1/120 s, ISO 100) are 0 stops and an unchanged scene looks as before. Set
  `referenceEV` to the setting that should look as the scene was lit.
- **Depth of field**: `apply` gives `DOF` the focus distance, the focal length (millimetres to metres) and the f-number.
  `depthOfField(coc)` and `blurDiameter(distance)` are the thin-lens formulas, with a circle of confusion of
  `filmGauge / 1500` unless you pass one.
- **Motion blur**: `shutterFraction` is the exposure time as a share of the frame interval at `frameRate`, at most 1;
  `MotionBlur.shutter` takes it, and `shutterAngle` is the same as a rotary shutter's angle.
- **Lens**: `apply({camera, aspect})` sets `camera.fov` from the focal length and film gauge; `apply({projection})` sets
  a `CameraProjection`'s `focalLength` and `filmGauge`.
- **Targets**: `apply` writes only the targets you pass. `exposure` takes anything with an `exposure` option in stops
  (`Tonemap`, `Bloom`, `PostStack`), whose own ranges apply. Errors: `Invalid physical camera; ...` for a value that is
  not finite and above 0, or a focus distance inside the focal length.

## Wide-angle projections: `@margoengine/cameras/panini`

A plain perspective stretches the edges of a wide view. `WideAngle` draws the scene rectilinear at a wide field of view
and resamples it as a Panini or a fisheye picture, in a `PostStack`. WebGPU, perspective cameras. 0 core bytes.

```ts
import {PostStack} from 'margoengine/post';
import {WideAngle} from 'margoengine/cameras/panini';
import {Engine} from 'margoengine/core';
declare const px: number;
declare const py: number;
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);

engine.camera.fov = 100;                                   // the rectilinear picture the stage resamples
const wide = new WideAngle({mode: 'panini', distance: 1}); // 'panini' | 'equidistant' | 'equisolid' | 'stereographic' | 'orthographic'
PostStack.attach(engine, [wide]);                          // after the display effect: [new Tonemap(), wide]
// or alone: const wide = await WideAngle.attach(engine, {mode: 'panini'}); (needs @margoengine/post)
wide.options.distance = 0.6;                               // read every frame, like mode and crop
wide.enabled = false;                                      // the plain picture

// Where a click on the projected picture lands on the source picture, for engine.pick or overlays:
const map = wide.map(engine.camera.fov, canvas.width / canvas.height);
const [x, y] = map.toSource(2 * px / canvas.width - 1, 1 - 2 * py / canvas.height)!; // normalised, y up; null outside
map.toOutput(x, y);                                        // and back
```

- **Panini** keeps vertical lines vertical and straight lines through the centre straight, and compresses the sides
  of a wide view toward the centre. `distance` 0 is the plain picture, 1 the classic Panini, larger values bend toward
  a cylinder. Projection after Sharpless, Postle and German (2010).
- **Fisheye** modes follow r = f·g(θ): equidistant θ, equisolid 2 sin(θ/2), stereographic 2 tan(θ/2), orthographic
  sin θ. The source is one rectilinear picture, so a fisheye reaches only as far as that picture does: under 180
  degrees across, in practice 120 to 150. A full 180 degree circle needs a cube capture, which this does not do.
- **Crop**: the output plane is zoomed in just enough that no pixel falls outside the source (`crop`, default true);
  `map.zoom` says by how much. With `crop: false` the uncovered corners are black.
- **Camera**: it reads `engine.camera.fov` and the frame's shape each frame, so a lens set with `focalLength` works.
  Draw the source at the field of view you want to see across.
- **Errors**: `Invalid wide angle mode; ...`, `Invalid wide angle distance; ...`, `Invalid wide angle view; ...`;
  MargoError `state` outside a PostStack, `unsupported` on WebGL2, `attached` and `disposed`.

Apache-2.0. Optional, tree-shakable package, about 1.7 kB min+gzip ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)); `/origin` and `/layers` are separate entries; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/cameras
