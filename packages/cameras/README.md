# @margoengine/cameras

`WideAngle` and `WideAngleCube` detach from their owning scene when disposed and
preserve same-name effects in other scenes. Device restoration keeps them attached.
Use `scene.use()` to attach their PostStack to a secondary scene:

```ts
import {Engine} from 'margoengine/core';
import {PostStack} from 'margoengine/post/stack';
import {CubeCamera} from 'margoengine/environment/cube-camera';
import {WideAngle} from 'margoengine/cameras/panini';
import {WideAngleCube} from 'margoengine/cameras/wide-cube';
const engine = await Engine.create(document.querySelector('canvas')!, {backend:'webgpu'});
const product = engine.createScene('product');
const cube = new CubeCamera({size:64});
product.use(cube);
const stack = new PostStack([new WideAngleCube({cube}), new WideAngle()]);
product.use(stack);
stack.dispose();
cube.dispose();
engine.dispose();
```

Import `margoengine/cameras` from the `margoengine` package, or `@margoengine/cameras` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Orthographic projection and exactly vertical (top-down and bottom-up) views for core's camera, for CAD, plans, maps
and isometric views. Culling, `engine.pick`, selection, bvh rays, TAA and every pass that reads `camera.matrix` see the
same view. It uses core's `camera.project` and `camera.up` hooks.

```ts
import {Engine} from 'margoengine/core';
import {CameraProjection} from 'margoengine/cameras';
import {loadGLTF} from 'margoengine/gltf-pro';
const canvas = document.querySelector('canvas')!;

const engine = await Engine.create(canvas, {camera: {position: [0, 40, 0], target: [0, 0, 0]}}); // straight down
const model = await loadGLTF(engine, '/model.glb');
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
  so `fitToBoundingBox`, the stage's `CADCameraControls` and `@margoengine/controls` dolly become ortho zoom and pan tracks
  the cursor exactly. Without `near`/`far` the depth range is `camera.far` deep and centred on the target (Blender's
  convention), so zooming in never clips a model at the eye.
- **Fixed size.** With an explicit `height` or all four bounds, `projection.fixedOrthographic` (also readable on the
  attached camera) is true: dolly changes only the distance, so `@margoengine/controls` zoom-to-cursor adds no pan.
- **Depth** is reversed-Z on WebGPU (near 1, far 0) like core, and -1..1 on WebGL. Orthographic depth is linear.
- **Vertical views**: pole detection follows the camera's current world-up vector,
  including a custom world up, rather than assuming the world Y axis. At a pole,
  screen up comes from projection.up (default [0,0,-1]); it must be finite and
  nonparallel to the view axis. Away from the pole, camera.up returns world up.
  Assigning camera.up changes world up while the projection is attached. The
  camera position stays exact; passes that rebuild the view read the same camera.up.
  With world up [0,0,1] and a view down Z, supply projection.up [0,1,0] instead of
  the default. Invalid world/screen up throws RangeError when evaluated.
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
import {Raycaster} from 'margoengine/bvh';
import {Engine} from 'margoengine/core';
import {boxGeometry} from 'margoengine/geometry';
import {Material, createMesh} from 'margoengine/materials';
const x = 0;
const y = 0;
const engine = await Engine.create(document.querySelector('canvas')!);

const material = new Material({color: '#8d99a6', doubleSided: true});
const flange = createMesh(engine, boxGeometry(0.4, 0.4, 0.05), material).root;
const origin = FloatingOrigin.attach(engine);          // default ratio 1000
origin.place(flange, [2_880_000.12, 3_600_000.65, 3_840_000.31]); // float64 world metres; root meshes or model.root
origin.lookAt([2_880_000.15, 3_600_000.68, 3_840_000.35], [2_880_000.12, 3_600_000.65, 3_840_000.31]);
origin.worldPosition(flange);                          // float64 back
const hit = new Raycaster().setFromEngine(engine, x, y).intersectEngine(engine)[0];
origin.toWorld(hit.point);                             // pick point in float64 world coordinates
const worldPlane: [number, number, number, number] = [0, 0, 1, -3_840_000.31];
material.clippingPlanes = [origin.toLocalPlane(worldPlane)];
origin.onRebase(() => { material.clippingPlanes = [origin.toLocalPlane(worldPlane)]; });
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
import {Reflector} from 'margoengine/environment/reflector';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Camera, Engine} from 'margoengine/core';
const top = new Camera({position: [0, 20, 0], target: [0, 0, 0]});
const engine = await Engine.create(document.querySelector('canvas')!);

const helpers = await loadGLTF(engine, '/helpers.glb');
const mirror = Reflector.attach(engine, {width: 4, height: 3});
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
const picture = new OffscreenCanvas(8192, 4608).getContext('2d')!;
for (const t of tileOffsets(8192, 4608, 2048, 1152)) {
  projection.setViewOffset(t.fullWidth, t.fullHeight, t.x, t.y, t.width, t.height);
  engine.render();
  picture.drawImage(canvas, t.x, t.y); // into the big image at (t.x, t.y)
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
// The viewer's head in world metres, here from the pointer; the screen stays a window onto the scene.
addEventListener('pointermove', (event) => window.setEye([event.clientX / innerWidth - 0.5, 0.4, 0.8]));

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
import {PostStack} from 'margoengine/post';
import {MotionBlur} from 'margoengine/post/motion-blur';
import {TAA} from 'margoengine/taa';
import {Tonemap} from 'margoengine/tonemap';
import {PhysicalCamera} from 'margoengine/cameras/physical';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

const dof = new DOF(), tonemap = new Tonemap();
const taa = TAA.attach(engine, {depth: () => stack.depthTexture});
const motionBlur = new MotionBlur({velocity: () => taa.velocity});
const stack = PostStack.attach(engine, [dof, motionBlur, tonemap]);
const camera = new PhysicalCamera({focalLength: 85, aperture: 1.8, shutter: 1 / 120, iso: 200, focusDistance: 3});
camera.apply({dof, motionBlur, exposure: tonemap, camera: engine.camera, aspect: 16 / 9});
camera.aperture = 5.6;                  // stops down: darker, deeper focus
camera.apply({dof, motionBlur, exposure: tonemap});
camera.exposure;                        // stops against the reference: -1 at f/5.6, 1/120 s, ISO 200
camera.depthOfField();                  // {hyperfocal, near, far} in metres, far is Infinity past the hyperfocal distance
camera.blurDiameter(10);                // mm of blur on the sensor for a point 10 m away
engine.start();                         // TAA wraps the shared HDR stack; blur uses its velocity
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
const px = 0;
const py = 0;
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
  degrees across, in practice 120 to 150. For 180 degrees and past it, use `WideAngleCube` below.
- **Crop**: the output plane is zoomed in just enough that no pixel falls outside the source (`crop`, default true);
  `map.zoom` says by how much. With `crop: false` the uncovered corners are black.
- **Camera**: it reads `engine.camera.fov` and the frame's shape each frame, so a lens set with `focalLength` works.
  Draw the source at the field of view you want to see across.
- **Errors**: `Invalid wide angle mode; ...`, `Invalid wide angle distance; ...`, `Invalid wide angle view; ...`;
  MargoError `state` outside a PostStack, `unsupported` on WebGL2, `attached` and `disposed`.

## Past 180 degrees: `@margoengine/cameras/wide-cube`

`WideAngleCube` reads a cube captured at the camera, so a fisheye or a Panini sees the whole sphere: `fov` is degrees across
the width, up to 360 for equidistant and equisolid. WebGPU. Needs `@margoengine/post` and `@margoengine/environment`.

```ts
import {WideAngleCube} from 'margoengine/cameras/wide-cube';
import {Engine} from 'margoengine/core';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);

const wide = await WideAngleCube.attach(engine, {mode: 'equidistant', fov: 220, size: 512});
wide.options.fov = 280;                                    // read every frame, like mode, distance and circle
wide.facesPerFrame = 2;                                    // spread the capture over three frames
engine.start();                                            // captures before each frame; with engine.render(), call wide.capture() first

// The direction shown at a pointer position, in camera space (forward is [0, 0, -1]):
const ray = wide.map(canvas.width / canvas.height).toDirection(0.5, 0); // null outside the picture
wide.dispose();                                            // the effect, its stack and its cube
```

- **Cost**: six scene draws a frame at `facesPerFrame` 6, on top of the main draw, which the stage replaces. `size`
  (default 512) sets the sharpness: a face of 512 is about 5.7 texels a degree.
- **Reach**: equidistant and equisolid up to 360, stereographic below 360, orthographic 180, Panini below 360 at `distance`
  1 (`distance` 0 stops below 180, larger values also stop short, because the projection folds back). A `fov` past that throws.
- **Circle**: `circle` (default true) leaves black past half of `fov`; false fills the corners as far as the law reaches.
- **Light**: the cube holds linear light and this is an HDR stage, so tone mapping comes after it, and a display effect
  goes after it in your own stack: `const cube = CubeCamera.attach(engine, {size: 512}); PostStack.attach(engine, [new WideAngleCube({cube}), new Tonemap()]);`
  Faces run the scene passes only, so HDR effects ahead of this stage do not reach the picture. The camera's `fov` is not used.
- **Errors**: `Invalid wide angle fov ...` and the `WideAngle` errors; MargoError `state` outside a PostStack, with no cube,
  or for `capture()` before attaching; `unsupported` on WebGL2, `attached` and `disposed`.

Apache-2.0. Optional, tree-shakable package; `/origin` and `/layers` are separate entries; core peer: ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/cameras

## Spherical capture: optional /panorama

capturePanorama(engine, options) returns one complete 360 by 180 degree
equirectangular image. It requires WebGPU or the full WebGL2 compatibility layer;
the native WebGL2 preview does not supply this WebGPU texture/readback API. Without
a cube option it lazily imports the optional environment/cube-camera entry, creates
a temporary CubeCamera at position (default engine.camera.position), captures all
six faces and disposes it, including on failure. Install that optional peer when
using this route. The main camera, canvas dimensions and scene state are preserved.

size is the temporary cube's power-of-two face edge (8..2048, default 256). width
defaults to 4*size, must be an even integer >=2, and height is width/2. The device's
maxTextureDimension2D and maxBufferSize also apply, including 256-byte row padding
in the readback buffer. Large captures allocate six cube faces, an output texture
and a readback buffer; choose a size appropriate to the device.

With cube, pass a caller-owned linear-light GPUTextureView and optional update(faces).
The view must be a compatible cube on the engine device. An update method is called
with 6 and must return 6; omit it for an already baked cube. The caller keeps cube
ownership. The image runs top-to-bottom, +Y at the top and -Z at the center. yaw
defaults 0 radians; positive yaw turns the center toward +X. panoramaDirection(u,v,yaw)
exposes the same mapping, with wrapping u and v in [0,1].

format defaults srgb: Uint8ClampedArray RGBA8 display pixels, with exposure (default
0 stops) applied before the sRGB transfer and clipping. linear returns Float32Array
RGBA32F in linear light, without exposure or display clipping. It does not restore
HDR range absent from the supplied cube. panoramaPNG(image, signal?) encodes an srgb
image as a PNG Blob and rejects linear data. Both operations accept AbortSignal;
abort rejects with its reason, ends the wait and releases owned temporary resources.
Borrowed cubes remain live. An abort cannot undo GPU work already submitted.

```ts
import {Engine, box, PbrMaterial} from '@margoengine/core';
import {capturePanorama, panoramaPNG, panoramaDirection} from '@margoengine/cameras/panorama';
const canvas = document.body.appendChild(document.createElement('canvas'));
const engine = await Engine.create(canvas, {backend: 'webgpu'});
engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial()).setPosition([0, 0, -3]);
const controller = new AbortController();
const image = await capturePanorama(engine, {size: 64, width: 256, signal: controller.signal});
if (image.width !== 256 || image.height !== 128) throw new Error('Unexpected panorama dimensions');
const png = await panoramaPNG(image, controller.signal);
console.log(png.size, panoramaDirection(0.5, 0.5)); // Center looks along -Z.
const reason = new Error('Capture cancelled by the application');
const cancelled = await capturePanorama(engine, {signal: AbortSignal.abort(reason)})
  .then(() => false, error => error === reason);
if (!cancelled) throw new Error('Capture did not preserve the abort reason');
engine.dispose(); canvas.remove();
```

A reusable cube keeps its ownership across both display and linear captures:

```ts
import {Engine} from '@margoengine/core';
import {CubeCamera} from '@margoengine/environment/cube-camera';
import {capturePanorama} from '@margoengine/cameras/panorama';
const canvas = document.body.appendChild(document.createElement('canvas'));
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const cube = CubeCamera.attach(engine, {size: 64});
const linear = await capturePanorama(engine, {cube, width: 256, format: 'linear', yaw: Math.PI / 2});
console.log(linear.data instanceof Float32Array, linear.data.length);
cube.dispose(); engine.dispose(); canvas.remove();
```

## Non-XR stereo: optional /stereo

StereoRig derives two parallel off-axis cameras from a source Camera without
changing its pose or projection. eyeSeparation defaults to 0.064 world units
(normally metres) and must be finite/nonnegative. focusDistance defaults to the
camera-to-target distance and must be positive, with Infinity allowed. It is the
zero-parallax distance, not camera convergence by toe-in. With an orthographic
source the projection has no binocular depth disparity. Call rig.update(source,
aspect) after source changes; aspect may be a function read after canvas resize.
rig.left and rig.right are reusable camera objects, not separately owned devices.

StereoOutput owns the rig, two RGBA8 eye textures, uniforms and packing pipeline.
Construct it with an engine and call render(deltaSeconds) from the application's
frame loop. Do not also call engine.start or engine.render for that same frame.
Scene/plugin animation advances once for the eye pair; scene rendering runs twice.
The default camera/scene are engine.camera/engine.scene; layers defaults to the
source camera's layer mask. Explicit camera, scene and layers override those choices.

mode defaults side-by-side; top-bottom, anaglyph and parallax-barrier are also
available. The packed modes give each eye half the corresponding canvas dimension
(rounded up); other modes use full-size eye images. Anaglyph uses the documented
Dubois red/cyan matrix in linear light with per-eye clipping; glasses and display
color affect its perceived result. parallax-barrier interleaves physical drawing-
buffer columns by default, or rows with barrierAxis. barrierPhase 0 (default) or 1
sets left-eye stripe parity. swapEyes defaults false. These are non-XR display
layouts; the application supplies any display alignment or viewing hardware.

Options are mutable and validated on render. Eye targets rebuild after canvas size,
packing size, device or output format changes. StereoOutput requires WebGPU or the
full compatibility layer, and does not attach a clock/plugin or dispose the engine.
dispose() releases its eye textures/uniforms and is idempotent; subsequent render
throws a coded disposed error. Do not reuse a disposed output.

```ts
import {Engine, box, PbrMaterial} from '@margoengine/core';
import {StereoOutput, StereoRig} from '@margoengine/cameras/stereo';
const canvas = document.body.appendChild(document.createElement('canvas'));
canvas.width = 640; canvas.height = 320;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial());
const rig = new StereoRig({eyeSeparation: 0.064, focusDistance: 4});
rig.update(engine.camera, canvas.width / canvas.height / 2);
console.log(rig.left.position, rig.right.position);
const output = new StereoOutput(engine, {mode: 'side-by-side', eyeSeparation: 0.064, focusDistance: 4});
// The application owns this frame loop. Delta is seconds, measured by that loop.
const frame = (delta: number) => output.render(delta);
for (const mode of ['side-by-side', 'top-bottom', 'anaglyph', 'parallax-barrier'] as const) {
  output.options.mode = mode;
  frame(1 / 60);
}
output.options.mode = 'parallax-barrier';
output.options.barrierAxis = 'rows';
output.options.barrierPhase = 1;
output.options.swapEyes = true;
frame(1 / 60);
output.dispose(); engine.dispose(); canvas.remove();
```

## Attachment ownership and validation

CameraProjection.attach(engine) registers the projection with the engine, while
new CameraProjection(options).attach(camera) only owns that camera's projection/up
hooks. The latter needs caller updates for fitting. dispose restores the camera's
plain world-up field and removes its owned project/fixedOrthographic hooks. It does
not destroy a camera or engine. Disposing the owning engine removes its registered
plugins. FloatingOrigin.dispose clears root tracking and listeners without undoing rebased
coordinates. onRebase returns an unsubscribe function for shorter subscriptions.
WideAngle/WideAngleCube keep their owning scene registration and borrowed cube
ownership as shown at the start of this README. Use Symbol.dispose/using for
lifetimes scoped to a block where the target runtime supports explicit disposal.

Run from the repository root after npm run build:packages:

- npm run test:gpu --workspace @margoengine/cameras checks projection, picking,
  view-offset and wide-angle rendering on a real adapter.
- npm run test:browser:panorama --workspace @margoengine/cameras checks spherical
  orientation, PNG pixels, float output, borrowed cubes, limits, abort and cleanup.
- npm run test:browser:stereo --workspace @margoengine/cameras checks geometry,
  packing/stripe parity, layers, resize, disposal and device restoration.
  Repeat these three commands with -- --compat for the full WebGL2 compatibility
  layer; they use the same scenes and assertions.

These correctness fixtures make no speed or cross-device quality claim. Works with
the [J6 public CAD-format viewer](../../docs/integration-engineering.md), including
its orthographic camera and navigation-profile attachment/restoration checks.
