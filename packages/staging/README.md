# @margoengine/staging

Product-shot staging. `ContactShadows`: the soft ground-contact shadow three.js users build from the ContactShadows
example. The added meshes are drawn from the ground looking up into a small texture (darker the closer to the
ground), blurred twice, and laid on the ground as a shadow-catcher plane over whatever is there (a floor mesh, a
background, nothing). No light direction and no shadow map, so it works with or without `@margoengine/shadows`.

```ts
import {Engine} from '@margoengine/core';
import {loadGLTF} from '@margoengine/gltf-pro';
import {ContactShadows} from '@margoengine/staging';

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
512), `static` (default false).

- **Cost** (Intel Arc 140V laptop iGPU, Edge 155, 1280x720, AC; `node packages/staging/test/browser-check.mjs`, JSON in
  `examples/package-benchmarks/results/staging-contact.json`): a texture update (occluders + 4 blur passes) takes
  0.05 ms at 256, 0.25 ms at 512 and 0.9-1.1 ms at 1024; the plane 0.02-0.04 ms (4x MSAA). With `static: true` an
  unchanged scene costs only the plane.
- **`static: true`** re-renders the texture only when a transform, visibility, source, option or the resolution
  changes, or after `invalidate()`. Skinned or morphed models change without a transform change: keep the default
  (every frame) for them, or call `invalidate()` per pose.
- **Order**: drawn after core's main pass and before glTF models (frame-graph order 0.5), with depth test and no depth
  write, lifted 0.01% of the plane size above the ground so it does not z-fight with a floor mesh there. A model in front
  of the plane covers it; a transparent glTF primitive blends over it. Not drawn when the camera is below the ground.
- **Sources**: anything with `shadowPrimitives` (gltf-pro `PBRModel`, `@margoengine/materials` meshes), same shape as
  `@margoengine/shadows`; alpha-masked materials honour their cutout, blended ones are skipped. Instanced primitives (gltf-pro `PBRInstances`) draw every instance in one occluder draw. Hidden meshes and
  disposed sources drop out.

Limits: Y-up ground only; the blur is uniform (three.js's pattern), so the shadow does not get softer with height
like a real penumbra; `size` should cover the footprint plus the blur, or the shadow is cut at the plane edge; WebGPU
only (nothing is drawn on the WebGL2 fallback); the plane is not in SSAO's G-buffer or picking.

MIT. Optional, tree-shakable package, about 4.6 kB min+gzip ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)); core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/staging. Real GPU: `node packages/staging/test/browser-check.mjs`.
