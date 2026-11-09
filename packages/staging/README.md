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

Options (all optional): `position` (ground centre; the ground is the plane y = position[1], default `[0, 0, 0]`),
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

Limits: Y-up ground only; the blur is uniform, so the shadow does not get softer with height
like a real penumbra; `size` should cover the footprint plus the blur, or the shadow is cut at the plane edge; WebGPU
only (nothing is drawn on the WebGL2 fallback); the plane is not in SSAO's G-buffer or picking.

Apache-2.0. Optional, tree-shakable package; measured sizes are in [entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json). Core peer: ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/staging. Real GPU: `node packages/staging/test/browser-check.mjs`.


## Ray-traced reference

After building, run `node scripts/gpu-lock.mjs run --max=3 --wait-max=1 --owner=codex-168 -- node packages/staging/scripts/rival-bench.mjs`.
The default effect is compared with 4096 cosine rays per exposed-ground pixel around a sphere under uniform
hemispherical lighting. Independent projected-solid-angle tests validate the ray tracer. Normalized darkness
MAE is 0.048174; the local contact cue differs from broad physical occlusion. This remains an open picture
loss. [Scene, metrics and scope](../../docs/whitepaper/perf-vs-rivals.md).

## A product on the HDR floor

Ground projection already lives in `@margoengine/environment/ground`. Combine it with this package's
shadow catcher. Draw the background at order `0.25`, before the contact plane at `0.5`, so the background
does not paint over the shadow:

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {EnvironmentLighting} from 'margoengine/environment';
import {GroundProjectedBackground} from 'margoengine/environment/ground';
import {ContactShadows} from 'margoengine/staging';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu', camera: {position: [0, 2, 4], target: [0, 0.5, 0]},
});
const light = await EnvironmentLighting.load(engine, '/garage.hdr', {signal: AbortSignal.timeout(30_000)});
GroundProjectedBackground.attach(engine, light.environment, {height: 1.6, radius: 20, order: 0.25});
const product = engine.createMesh().setGeometry(box(1, 1, 1))
  .setMaterial(new PbrMaterial({color: '#8090a0'})).setPosition([0, 0.5, 0]);
const shadow = ContactShadows.attach(engine, {size: 4, height: 2, blur: 0.12});
shadow.add(product);
engine.start();
// Later: engine.dispose() releases the lighting, backdrop and shadow.
```

Keep the catcher position at the background's `center` (both default to the origin). This is a contact
cue over the photographed floor; it does not infer light directions or reproduce the HDR's physical
shadows. The existing Y-up and native WebGL2 limitations above apply. `test/ground-browser.mjs` compares
on/off pixels using the licensed OpenEXR BrightRings image, checks the model remains visible, removes
the caster and replaces a real device. Run it with `--compat` for the WebGL2 compatibility layer;
that path passes the same assertions. The native WebGL2 engine remains unsupported. The box is a
generated stand-in, not a photographed product.

## Accumulated soft shadows

`@margoengine/staging/accumulate` samples a horizontal disk light once per rendered frame and averages
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
`lightPosition: [0, 8, 0]` (world coordinates), `lightRadius: 2`, `frames: 64` (integer 1..1024),
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
grid. The receiver remains Y-up; the light must be above the whole casting volume. No speed claim.

WebGPU and the WebGL2 compatibility layer pass `test/accumulate-browser.mjs` (append `--compat` for the
layer): exact projected sums at all 4096 texels for three heights, convergence, 1024 samples, empty scenes,
an additional 4096-texel PBR caster case, resize, removal, actual device replacement, scene ownership
and coexistence with ContactShadows. This Windows oracle includes Direct3D's
specified eight-bit coordinate snapping; it is not an assertion of subpixel identity across other GPU
backends. The geometry is a stand-in. Native WebGL2 throws coded `unsupported` with a help link.

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
