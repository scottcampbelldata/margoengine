# @margoengine/staging

Install `npm i margoengine` and import `margoengine/staging` (or this package alone: `npm i @margoengine/staging`, imported as `@margoengine/staging`; the two are the same module).

Product-shot staging. `ContactShadows`: a soft ground-contact shadow.
The added meshes are drawn from the ground looking up into a small texture (darker the closer to the
ground), softened by one separable Gaussian blur (sigma = half the `blur` radius, sized per axis so it stays round
in world units on a non-square plane), and laid on the ground as a shadow-catcher plane over whatever is there (a floor mesh, a
background, nothing). No light direction and no shadow map, so it works with or without `@margoengine/shadows`.

```ts
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {ContactShadows} from 'margoengine/staging';

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
  `@margoengine/shadows`; alpha-masked materials honour their cutout, blended ones are skipped. Instanced primitives (gltf-pro `PBRInstances`) draw every instance in one occluder draw. Hidden meshes and
  disposed sources drop out.

Limits: Y-up ground only; the blur is uniform, so the shadow does not get softer with height
like a real penumbra; `size` should cover the footprint plus the blur, or the shadow is cut at the plane edge; WebGPU
only (nothing is drawn on the WebGL2 fallback); the plane is not in SSAO's G-buffer or picking.

MIT. Optional, tree-shakable package, about 6.0 kB min+gzip ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)); core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/staging. Real GPU: `node packages/staging/test/browser-check.mjs`.
