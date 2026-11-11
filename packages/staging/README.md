# @margoengine/staging

Import `margoengine/staging` from the `margoengine` package, or `@margoengine/staging` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Product-shot staging. `ContactShadows`: a soft ground-contact shadow.
The added meshes are drawn from the ground looking up into a small texture (darker the closer to the
ground), softened by one separable Gaussian blur (sigma = half the `blur` radius, sized per axis so it stays round
in world units on a non-square plane), and laid on the ground as a shadow-catcher plane over whatever is there (a floor mesh, a
background, nothing). No light direction and no shadow map, so it works with or without `@margoengine/shadows`.

```ts
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {ContactShadows} from 'margoengine/staging';
const canvas = document.querySelector('canvas')!;

const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/shoe.glb');
const contact = ContactShadows.attach(engine, {opacity: 0.6, blur: 0.08});
contact.fit(model.bounds);   // centre under the model: ground at minY, 2x the footprint, height = model height
contact.add(model);          // gltf-pro models, materials meshes and core meshes; returns a remover
contact.options.opacity = 0.4; // options are live
contact.dispose();           // or engine.removePlugin('contact-shadows')
```

Options (all optional): `position` (world ground centre, default `[0, 0, 0]`), `up` (receiver normal, default `[0, 1, 0]`),
`size` (plane width × depth in world units, or one number, default 4), `height` (geometry up to this far above the ground
casts, fading linearly to nothing at it, default 1), `blur` (world units, default 1.5% of the larger side), `opacity`
(default 0.6), `color` (default black, written as-is to the scene target), `resolution` (texels per side, default
256), `static` (default false).

- **Cost**: a texture update is three passes (occluders, horizontal blur, vertical blur), the plane one more. Measured
  on an NVIDIA RTX A6000 at 1280x720 with 4x MSAA (`node packages/staging/test/browser-check.mjs`, timestamp queries,
  [staging-contact.json](../../examples/package-benchmarks/results/staging-contact.json)): texture update 0.010 /
  0.029 / 0.157 ms at resolution 256 / 512 / 1024, plane 0.008-0.009 ms. With `static: true` an unchanged scene costs
  only the plane.
- **`static: true`** re-renders the texture only when a transform, visibility, source, option or the resolution
  changes, or after `invalidate()`. Skinned or morphed models change without a transform change: keep the default
  (every frame) for them, or call `invalidate()` per pose.
- **Order**: drawn after core's main pass and before glTF models (frame-graph order 0.5), with depth test and no depth
  write, lifted 0.01% of the plane size above the ground so it does not z-fight with a floor mesh there. A model in front
  of the plane covers it; a transparent glTF primitive blends over it. Not drawn when the camera is below the ground.
- **Sources**: anything with `shadowPrimitives` (gltf-pro `PBRModel`, `@margoengine/materials` meshes), same shape as
  `@margoengine/shadows`; alpha-masked materials honour their cutout (`alphaTransform`, including glTF
  `KHR_texture_transform`, the materials `alphaMap` as `opacity`, and `vertexAlpha: false`), blended ones are skipped.
  `displacement` moves the occluder and `clip` cuts it (materials `displacementMap`, and `clippingPlanes` with `clipShadows`). An
  `opacity`, `displacement` or `clip` caster changes on the GPU alone, so a `static` shadow redraws every frame while one is added. Instanced primitives (gltf-pro `PBRInstances`) draw every instance in one occluder draw. Hidden meshes and
  disposed sources drop out.

Limits: the blur is uniform, so the shadow does not get softer with height
like a real penumbra; `size` should cover the footprint plus the blur, or the shadow is cut at the plane edge; WebGPU
and the WebGL2 compatibility layer (the native preview throws linked `unsupported`); the plane is not in SSAO's G-buffer or picking.

Apache-2.0. Optional, tree-shakable package; measured sizes are in [entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json). Core peer: ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/staging. Real GPU: `node packages/staging/test/browser-check.mjs`.


## Any up axis and WebGL2

Both receivers accept `up`, a finite nonzero world direction. It is normalized internally, including
subnormal and near-maximum finite components. `position` is a point on the plane; `height` and the
small anti-z-fighting lift run along the normal. Width runs along world X projected onto the plane
(world Z instead when the normalized X component has magnitude at least 0.9); depth is width cross
normal. Changing `up` live invalidates contact caching and restarts accumulation. The tangent frame
can switch at that threshold; it is deterministic, not a continuously transported rotation.

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {ContactShadows} from 'margoengine/staging';
const webgpu = 'gpu' in navigator && (await navigator.gpu.requestAdapter()) !== null;
if (!webgpu) await (await import('margoengine/webgl2-compat')).install();
const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: {position: [0, -4, 3], target: [0, 0, 0.5]},
});
engine.camera.up = [0, 0, 1];
const product = engine.createMesh().setGeometry(box(1, 1, 1))
  .setMaterial(new PbrMaterial({color: '#8090a0'})).setPosition([0, 0, 0.5]);
ContactShadows.attach(engine, {up: [0, 0, 1], size: 4, height: 2}).add(product);
engine.start();
// Later: engine.dispose().
```

`fit(bounds, spread = 2)` projects the eight corners of the world-axis-aligned bounds analytically
onto the receiver frame, puts the plane at the lowest support point along `up`, and covers the
projected footprint. This is conservative for a rotated product's world AABB. It does not orient
the product, camera, HDR backdrop or light automatically. For accumulated shadows, set a world
`lightPosition` whose signed height above the receiver exceeds `height` after float32 rounding.

WebGPU and the installed WebGL2 compatibility layer draw the same receiver code. The older native
WebGL2 preview lacks the required programmable passes and throws `unsupported` with a help link.
`test/orientation-browser.mjs` (also with `--compat`) compares all 4096 shadow texels through six
cardinal and two sloped orientations for contact and accumulation, asserts visible floor pixels
and backside rejection, replaces the real device, clears removed geometry and disposes twice.
The rectangle is a generated geometry oracle, not a real product quality claim. No speed claim.

## Blurred glossy product floor

The existing `@margoengine/environment/reflector` supplies this floor; staging adds no duplicate entry.
Its local XY rectangle faces +Z. Rotate it by -PI/2 about X to face +Y, then choose `roughness`:

```ts
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Reflector} from 'margoengine/environment/reflector';
const webgpu = 'gpu' in navigator && (await navigator.gpu.requestAdapter()) !== null;
if (!webgpu) await (await import('margoengine/webgl2-compat')).install();
const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: {position: [0, 0.4, 0.9], target: [0, 0.2, 0]},
});
engine.scene.background = '#cccccc';
await loadGLTF(engine, '/product.glb', {signal: AbortSignal.timeout(30_000)});
const floor = Reflector.attach(engine, {width: 2, height: 2, roughness: 0.4, color: [0.6, 0.6, 0.6]});
floor.node.setRotation([-Math.PI / 2, 0, 0]);
floor.node.setPosition([0, -0.0001, 0]); // for a product whose lowest world Y is zero
engine.start();
// Later: engine.dispose(). For a manual render loop: floor.update(); engine.render().
```

The floor renders the scene through a camera mirrored in its plane, clips geometry behind it and
samples a box-filtered mip chain. Defaults: width/height 1, white tint, roughness 0 (sharp), resolution 1
(fraction of the canvas, over 0 through 2), clipBias 0, autoUpdate true, order 1. `roughness` in 0..1
selects the mip level; 1 uses the coarsest of at most eight mips. This is a tinted opaque planar
reflection with image blur. It has no Fresnel term, distance-dependent roughness cone or GGX floor
BRDF. Other mirrors show their previous capture, so there is one bounce per frame. A capture costs
another scene render; no speed claim. See the environment README for exclusions and custom captures.

`test/floor-browser.mjs` and its `--compat` variant use the real licensed 20,734-triangle FlightHelmet,
assert visible reflections below the full product silhouette, check every mip component against
independent 2x2 means, cover exact half-rounding boundaries, and require identical displayed pixels
after actual device replacement. Resize, maximum roughness, invalid values, a uniform empty capture
and double disposal also pass. WebGPU and installed WebGL2 compatibility draw; native preview throws
linked `unsupported`. The viewport and rounding repairs live in environment, the owning package.

## Ray-traced reference

After building, run `node scripts/gpu-lock.mjs run --max=3 --wait-max=1 --owner=codex-168 -- node packages/staging/scripts/rival-bench.mjs`.
The default effect is compared with 4096 cosine rays per exposed-ground pixel around a sphere under uniform
hemispherical lighting. Independent projected-solid-angle tests validate the ray tracer. Normalized darkness
MAE is 0.048174: the default effect is a footprint cue by design. It darkens the ground under a caster by how
near the caster's underside is, which is cheap, one pass and cacheable with `static`, and a sphere's footprint
lies under the sphere itself. Broad sky occlusion beside a caster is `AmbientShadows` with `ambient: 1` (below):
on the same scene, pixels and 4096-ray reference it measures MAE 0.001561, mean darkness 0.048200 against
0.048351, on WebGPU and the WebGL2 compatibility layer (`test/sky-occlusion-browser.mjs`; add `--ambient` to the
command above for the full metrics). [Scene, metrics and scope](../../docs/whitepaper/perf-vs-rivals.md).

## A product on the HDR floor

Ground projection lives in `@margoengine/environment/ground`. The optional
`@margoengine/staging/ground` receiver infers a dominant light from the HDR's luminance-weighted
first radiance SH band, projects the product's shadow opposite that direction, and follows live
`environment.rotation`. Draw the backdrop at order `0.25`, before the receiver at `0.5`:

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {EnvironmentLighting} from 'margoengine/environment';
import {GroundProjectedBackground} from 'margoengine/environment/ground';
import {GroundShadows} from 'margoengine/staging/ground';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu', camera: {position: [0, 2, 4], target: [0, 0.5, 0]},
});
const light = await EnvironmentLighting.load(engine, '/garage.hdr', {signal: AbortSignal.timeout(30_000)});
GroundProjectedBackground.attach(engine, light.environment, {height: 1.6, radius: 20, order: 0.25});
const product = engine.createMesh().setGeometry(box(1, 1, 1))
  .setMaterial(new PbrMaterial({color: '#8090a0'})).setPosition([0, 0.5, 0]);
const shadow = GroundShadows.attach(engine, {environment: light.environment, size: 8, height: 2, blur: 0.12});
shadow.add(product);
engine.start();
// Later: engine.dispose() releases the lighting, backdrop and shadow.
```

Keep the receiver position at the background's `center` (both default to the origin). All contact
receiver options keep their defaults; `environment` defaults to the `environment` plugin in the
receiver's owning scene. Use `scene.use(new GroundShadows({environment, ...options}))` for a secondary
scene. Rotation and SH edits invalidate even a `static: true` receiver; intensity zero removes the
shadow. The HDR backdrop remains Y-up; the receiver accepts any `up`.

This is a single dominant directional-light approximation with the receiver's spatial blur, not the
full environment visibility integral or recovered photograph geometry. It cannot reproduce multiple
lights, full radiometry, HDR light size or shadows on the product itself. An isotropic field
(moment length <= 1e-6 of luminance L0) or a light at/below the receiver horizon (normal dot direction
<= 1e-6) draws no directional shadow. Choose `size` large enough for low-elevation light's long shadows.
`test/hdr-shadow-browser.mjs` proves PI rotation and HDR direction alignment in shadow pixels, actual
floor darkening, deterministic rotation reset and caster removal with a raised box and the licensed
FlightHelmet model under Poly Haven's photographed Small Empty Room 1 HDR. It runs on WebGPU and
WebGL2 compatibility. Native WebGL2 preview remains unsupported. `test/ground-browser.mjs` retains
the separate contact-only composition/device-restore proof.

## Accumulated soft shadows

`@margoengine/staging/accumulate` samples a disk light parallel to the receiver once per rendered frame and averages
its projected visibility on the ground. Contact edges stay sharp; raising geometry widens the penumbra.
After `frames` samples, only the receiving plane draws. Camera motion keeps this world-space history.

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {AccumulatedShadows} from 'margoengine/staging/accumulate';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu', camera: {position: [0, 3, 5], target: [0, 0.5, 0]},
});
const product = engine.createMesh().setGeometry(box(1, 1, 1))
  .setMaterial(new PbrMaterial({color: '#8090a0'})).setPosition([0, 0.5, 0]);
const shadow = AccumulatedShadows.attach(engine, {
  size: 6, height: 2, lightPosition: [1, 8, 1], lightRadius: 2, frames: 64,
});
shadow.add(product);
engine.start();
// shadow.samples counts the current history. Later: engine.dispose().
```

Options are copied on construction; edit `shadow.options` live afterward. Inherited `position`, `size`,
`height`, `opacity`, `color` and `resolution` keep the contact receiver's defaults. Added defaults:
`lightPosition: 8 * normalized up` (world coordinates, `[0, 8, 0]` for Y-up), `lightRadius: 2`, `frames: 64` (integer 1..1024),
`blur: 0` and `static: false` (these last two values are required). Receiver dimensions are 1e-6..1e6,
position and light components have magnitude at most 1e6, and radius is 0..1e6. The light's height above
the receiver must exceed `height` after float32 rounding. Invalid live settings throw before rendering.

Geometry/source/visibility/light/receiver changes restart accumulation. For in-place vertex or pose
changes, call `shadow.invalidate()`. Continuously changing casters restart every frame and do not
converge. GPU-only opacity/displacement/clipping changes retain the existing conservative invalidation.
`fit(bounds)` keeps the inherited receiver fit; move the light above its resulting height when needed.
`dispose()` / `using` releases all resources and detaches from the owning scene.

Method: radical-inverse base-2 radius with golden-angle azimuth selects disk points. Each projection
casts one binary shadow, unions overlapping casters with maximum blending, and sums it in ping-pong
R16F textures. Integer sums through 1024 are exact; the receiving plane divides once by the sample count.
Equal visibility weights do not integrate inverse-square falloff, cosine weights, HDR illumination or
indirect light. Thin detail is limited by the receiver resolution and the hardware rasterizer's subpixel
grid. The light must be above the whole casting volume along `up`. No speed claim.

WebGPU and the WebGL2 compatibility layer pass `test/accumulate-browser.mjs` (append `--compat` for the
layer): exact projected sums at all 4096 texels for three heights, convergence, 1024 samples, empty scenes,
an additional 4096-texel PBR caster case, resize, removal, actual device replacement, scene ownership
and coexistence with ContactShadows. This Windows oracle includes Direct3D's
specified eight-bit coordinate snapping; it is not an assertion of subpixel identity across other GPU
backends. The geometry is a stand-in. Native WebGL2 throws coded `unsupported` with a help link.

## Sky occlusion and several soft lights

`@margoengine/staging/accumulate-ambient` mixes up to 64 disk lights with cosine-weighted sky visibility. Each
frame projects one sample (a disk point, or a sky direction drawn from the cosine hemisphere) and the accumulator
averages them. With `ambient: 1` the ground darkens by the share of the sky the casters hide, so a ball resting
on the floor gets the soft ring a photograph shows, which the default footprint `ContactShadows` cannot draw.

```ts
import {Engine} from 'margoengine/core';
import {createMesh, PbrMaterial} from 'margoengine/materials';
import {sphereGeometry} from 'margoengine/geometry';
import {AmbientShadows} from 'margoengine/staging/accumulate-ambient';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu', camera: {position: [0, 3, 5], target: [0, 0.5, 0]},
});
const ball = createMesh(engine, sphereGeometry(0.5, 64, 32), new PbrMaterial({color: '#c04030'}));
ball.root.setPosition([0, 0.5, 0]);
const shadow = AmbientShadows.attach(engine, {ambient: 1, opacity: 1, frames: 256});
shadow.add(ball);
engine.start();
// Mix in a soft key light: AmbientShadows.attach(engine, {ambient: 0.5, lights: [{position: [2, 8, 1], radius: 2}]}).
```

Added defaults: `ambient: 0.5` (sky share of the visibility, 0..1), `lights` one disk from `lightPosition` and
`lightRadius`, each disk `radius: 2` and `intensity: 1` (relative weight). Up to 64 disks, each above the whole
caster slab; an empty list needs `ambient: 1`. Everything else is inherited from `AccumulatedShadows`. The result is
monochrome visibility on the receiver, with no per-light colour, inverse-square falloff or shadow on the product
itself. Measured on the ray-traced reference scene: exposed-ground MAE 0.001561, max 0.007994 at 1024 frames,
both GPU backends (`test/sky-occlusion-browser.mjs`). Method: Pharr and Green, "Ambient Occlusion", GPU Gems
chapter 17 (2004), visibility accumulated from many shadow projections; cosine sampling from Pharr, Jakob and
Humphreys, Physically Based Rendering 4th edition (2023), section A.5.3. No speed claim.

## Studio softboxes

The studio rig already lives in `@margoengine/environment/studio`; staging does not duplicate it.
`STUDIO_LIGHTS` contains an overhead box, a front-left key, a dimmer front-right fill and a rear rim
strip, designed for a camera on +Z. Use the generated image for lighting and the backdrop:

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {EnvironmentLighting} from 'margoengine/environment';
import {STUDIO_LIGHTS, studio} from 'margoengine/environment/studio';
import {GroundProjectedBackground} from 'margoengine/environment/ground';
import {ContactShadows} from 'margoengine/staging';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu', camera: {position: [0, 2.5, 5], target: [0, 0.4, 0]},
});
const lighting = await EnvironmentLighting.load(engine, studio({width: 128, lights: STUDIO_LIGHTS}), {
  size: 32, samples: 32, signal: AbortSignal.timeout(30_000),
});
GroundProjectedBackground.attach(engine, lighting.environment, {height: 1.6, radius: 20, order: 0.25});
const product = engine.createMesh().setGeometry(box(1, 1, 1))
  .setMaterial(new PbrMaterial({color: '#a08050', roughness: 0.3})).setPosition([0, 0.5, 0]);
ContactShadows.attach(engine, {size: 4, height: 2, blur: 0.15}).add(product);
engine.start();
// Later: engine.dispose() releases the rig, backdrop and catcher.
```

The image generator defaults to width 512, with a grey floor, walls and ceiling and four softboxes.
`width` is a power of two in 16..4096; angular box dimensions are in (0, PI), intensity in 0..65504,
softness in 0..1. See the [studio options](../environment/README.md#procedural-studio-environment)
for every default and custom lights. These are distant image lights: no parallax, distance falloff,
local light transforms or area-light shadow calculation. The catcher supplies its existing contact cue.
WebGPU and WebGL2 compatibility pass the existing studio value oracle and the staging composition
test (`ground-browser.mjs --studio`, optionally `--compat`), including actual device replacement,
caster removal and disposal. Native WebGL2 remains unsupported. Geometry is a generated stand-in.

## Framing and turntable

The existing optional stage viewer frames a glTF product, sets near/far to its bounds, adds a plain
background and orbits the camera about its target. No staging/frame entry is needed:

```ts
import {createStage} from 'margoengine';
import {addViewer} from 'margoengine/stage/viewer';
const app = await createStage(document.body, {backend: 'webgpu'});
const viewer = await addViewer(app, '/shoe.glb', {
  background: '#dfe1e4', turntable: {seconds: 30, resumeAfter: 3},
  signal: AbortSignal.timeout(30_000),
});
viewer.turntable = false; // set true to resume
// Later: viewer.dispose(); app.dispose();
```

See [all viewer options and defaults](../stage/README.md#model-viewer). Fit defaults to true;
turntable defaults to true with a 30-second period and 3-second resume delay. Reduced motion starts
it paused. Dragging pauses rotation; disposal removes listeners and the model, leaving the camera
where it is. The camera turns around world Y; the product and cached shadows stay fixed.
Bounds are fitted once, so call the camera's fitToBoundingBox after changing product geometry.
A glTF with no drawable bounds rejects; a failed setup restores camera state. Native WebGL2 is
unsupported; WebGL2 compatibility passes the same real-model pixel and radius assertions.
The FlightHelmet test fixture is a licensed real product model; no photographic quality or speed claim.
## An idle path-traced still

`@margoengine/staging/pathtrace` adds an idle controller to the existing optional
`@margoengine/voxel-pathtracer/mesh` integrator. Camera motion shows the ordinary raster frame;
after 0.25 unchanged-camera seconds, the viewport accumulates a still. Changing the camera or
canvas size clears the history. This entry loads the integrator and its feature-local Rust/Wasm
BVH only when `ProgressiveStill.attach` is called. Install the optional voxel-pathtracer peer
when using staging on its own.

This example makes a neutral plastic surface study of an existing model, explicitly replacing
its authored materials. `worldTriangles` snapshots world-space geometry; it does not transfer
textures, material extensions or a changing animation pose:

```ts
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {worldTriangles} from 'margoengine/bvh';
import {ProgressiveStill} from 'margoengine/staging/pathtrace';
const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: {position: [0, 0.3, 0.85], target: [0, 0.25, 0]},
});
const model = await loadGLTF(engine, '/shoe.glb', {signal: AbortSignal.timeout(30_000)});
const geometry = worldTriangles(engine, [model]);
const still = await ProgressiveStill.attach(engine, {
  scene: {
    revision: 1, models: [], instances: [],
    materials: [{id: 1, type: 'plastic', color: [0.55, 0.25, 0.08], roughness: 0.3}],
    meshes: [{id: 'product', positions: geometry.vertices, indices: geometry.indices, material: 1}],
    environment: {skyIntensity: 0.3, sunIntensity: 3, groundColor: [0.7, 0.7, 0.7]},
  },
  idleDelay: 0.25, maxSamples: 1024, denoise: true,
  signal: AbortSignal.timeout(30_000),
});
await still.ready;
engine.start();
// Explicit capture is available even while the viewport is moving.
const png = await still.capture({width: 128, height: 128, samples: 64,
  signal: AbortSignal.timeout(120_000)});
console.log(png.type); // image/png
// Later: engine.dispose() owns both the controller and integrator.
```

`idleDelay` is finite seconds in 0..60 (default 0.25). Zero begins immediately. All other options
and their defaults are the [mesh integrator's](../voxel-pathtracer/README.md#triangle-meshes-beside-voxels),
except the drawing order is fixed at 20 (the idle controller runs at 19). `active`, `stats`, `status`
and `ready` report the owned renderer. `invalidate()` restarts the idle interval and accumulation
after another interaction. `setScene(scene, {signal?})` builds a replacement static snapshot,
then restarts idle; failed or cancelled replacements preserve the current one. Rebuild the snapshot
after geometry or pose changes. `renderImage` returns linear floats; `capture` returns a PNG.
Attachment snapshots caller arrays before loading the integrator; source arrays may then be reused.
`dispose()` / `using` removes both owned plugins. Only one rendered view per engine is supported;
multiple views throw linked `unsupported`.

The integrator supplies multibounce transport, area lights, importance-sampled HDR environments,
plastic, metal, glass, emission and a denoiser. Its triangle input is flat-shaded and has no UV
textures, interpolated normals, cutouts, deformation or mesh material-extension conversion. A still
can be much cleaner than the raster approximation; arbitrary photographic material fidelity and
outside-renderer equality are not established. The finite bounce and scene limits of that entry apply.

Native WebGPU and the WebGL2 compatibility layer pass `test/pathtrace-browser.mjs`: the licensed
20,734-triangle FlightHelmet, a neutral material study, decreasing image error at 8 versus 64 samples
against 512 samples, analytic emission at every hit, exact raster restoration during motion and
disposal, identical repeated stills and actual device replacement. The layer's Windows path uses
ANGLE Vulkan. ANGLE Direct3D cannot finish compiling the inherited integrator and keeps raster;
see its documented backend limit. Plain WebGL2 gives linked `unsupported`. No speed or general
photographic-quality claim.

The idle still controller compares the unjittered camera and gives that projection to its integrator.
TAA subpixel jitter does not restart the idle delay or sample history, including `idleDelay: 0`.
Raster jitter is restored before TAA resolves.
