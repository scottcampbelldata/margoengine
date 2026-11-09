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
