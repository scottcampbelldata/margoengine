# @margoengine/fbx

Native binary and ASCII FBX import (FBX 7.x) for Margo's optional glTF-pro pipeline. No three.js: the package reads FBX itself and writes a GLB that keeps the node hierarchy, materials, textures, skins, blend shapes and animation clips.

```ts
import {loadFBX} from '@margoengine/fbx';
import {Animation} from '@margoengine/animation';
const model = await loadFBX(engine, '/assets/character.fbx');
const animation = Animation.attach(model);
```

`convertFBX(bytes)` returns a GLB; `parseFBX(engine, bytes)` returns a `PBRModel`; `loadFBX(engine, url)` fetches over HTTP(S). Budgets: 64 MiB input, 128 MiB converted output, one million expanded vertices, 256 MiB of decoded FBX arrays and 16 million decoded texture pixels. Loading honors `signal`. Textures referenced by file name are fetched relative to `resourcePath` (by default the FBX file's folder) and must be HTTP(S); embedded textures (`Video` content) need no fetch.

What is read:

- Binary FBX 7.x (32- and 64-bit record headers, zlib-compressed arrays through the platform `DecompressionStream`) and ASCII FBX 7.x. Older 6.x files are rejected.
- Geometry: polygons (n-gons ear-clipped in their plane), normals, all UV sets, vertex colors (sRGB to linear), per-polygon materials as one glTF primitive per material, geometric translation/rotation/scaling.
- Transforms: Lcl translation/rotation/scaling, all six rotation orders, pre/post rotation, rotation and scaling pivots and offsets, the three inherit types, Z-up files rotated to Y-up at the root.
- Materials: Phong and Lambert to metallic-roughness (linear diffuse color, opacity from TransparencyFactor/Opacity, roughness `sqrt(2 / (shininess + 2))`, metallic 0), diffuse and normal maps, texture wrap modes and UV scale/offset (`KHR_texture_transform`). Other legacy maps (specular, bump, emissive, ambient occlusion) are not converted.
- Skins: clusters, TransformLink bind matrices, the four strongest weights per vertex, BindPose rest poses for bones no cluster drives.
- Blend shapes as glTF morph targets, and AnimationStacks (first layer) as clips: translation, rotation (with pre/post rotation) and scale curves, and `DeformPercent` curves as morph weights.

Cameras, lights and NURBS curves become plain nodes. Only load trusted FBX assets: byte limits bound the work but the converter is not a sandbox.

The conversion follows the semantics of the previous three.js bridge (FBXLoader then GLTFExporter); `npm test` compares both on a fixture covering pivots, inherit types, n-gons, layered attributes, materials, a skin, a blend shape and clips. Deliberate differences: UVs are written with V flipped and images are embedded as stored, where the old path flipped the image instead (same rendering); normal maps are embedded unchanged (the old path inverted their green channel); morph weight animation now converts (it threw before); Euler steps of 180 degrees or more are sliced without duplicate key times; a mesh with several materials but one material for every polygon keeps its geometry (the old path dropped it).

Bundle size (minified + gzip, everything but `@margoengine/*` bundled): 85.8 kB with three.js before, 12.0 kB now (13.9 kB including the tree-shaken triangulator from `@margoengine/geometry`).

To add a real skinned asset to the WebGPU integration test, set MARGOENGINE_FBX_FIXTURE to its URL (or a Vite-served path) before running npm run test:modules:browser.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/fbx
