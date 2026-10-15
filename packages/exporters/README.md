# @margoengine/exporters

glTF 2.0 / GLB, STL, OBJ (with MTL), PLY and static USDZ export for Margo Engine scenes and plain geometry data, and
glTF/GLB export of gltf-pro models (loaded glTF and `@margoengine/materials` meshes) with skins, morph targets,
animation clips, instancing, textures and KHR material extensions.

Build from source with `npm run build` in `packages/exporters`.

## gltf-pro models (three.js GLTFExporter)

```ts
import {exportModel} from '@margoengine/exporters/model';      // also exported from the package root
import {Animation} from '@margoengine/animation';

const robot = await loadGLTF(engine, 'robot.glb');
const animation = Animation.attach(robot);
const glb = await exportModel(robot, {binary: true, animations: [animation]});   // Uint8Array, save as .glb
const {text, bin} = await exportModel([robot, crate], {embed: false, binUri: 'scene.bin'});  // .gltf + .bin
const small = await exportModel(helmet, {binary: true, maxTextureSize: 1024});  // browser: shrinks larger images
```

`exportModel(models, options)` takes one `PBRModel` or an array (each becomes scene roots; a moved `model.root` becomes
a wrapper node) and resolves to GLB bytes with `binary: true`, otherwise to the same `{json, text, bin, binUri}` as
`exportGLTF`. It is async because textures that have no encoded bytes are PNG-encoded.

- **What is written.** The active scene's nodes in document order (so node indices survive a round trip), with the live
  local transforms, names and visibility from the engine; meshes with every attribute (`TEXCOORD_1`, `COLOR_0`,
  `JOINTS_0`/`WEIGHTS_0`, custom `_ATTR`), indices and morph targets; current morph weights as node `weights` and
  `targetNames` in mesh extras; skins with joints, skeleton and inverse bind matrices; `EXT_mesh_gpu_instancing` from
  `primitive.instances` (TRS per drawn instance, tints as `_COLOR_0` as three.js writes them); materials from gltf-pro's
  live material record: metallic-roughness factors and textures, normal (scale), occlusion (strength) and emissive maps,
  alpha mode and cutoff, double-sided, `KHR_texture_transform`, `KHR_materials_emissive_strength`, `_unlit`, `_ior`,
  `_clearcoat`, `_transmission`, `_sheen`, `_specular` and `_volume` factors.
- **Lossless accessors.** Accessors are re-written from the data gltf-pro decoded (Draco, meshopt, sparse and quantized
  sources become plain float32), so a re-import reads byte-identical values; JOINTS become 8- or 16-bit, indices 16-bit
  up to 65,535 vertices. Skin weights are written divided by their sum (gltf-pro skins with that; unnormalized sources
  fail the Khronos validator). Shared arrays (time inputs, accessors used twice, meshes and materials used by several
  nodes) are written once.
- **Images.** A loaded image's encoded bytes are copied as they are (PNG, JPEG, KTX2, WebP, AVIF, with
  `KHR_texture_basisu`/`EXT_texture_webp`/`EXT_texture_avif` kept on the texture). `@margoengine/materials` textures
  (`mesh.material.map`, `metalRoughnessMap`, `normalMap`, `aoMap`, `emissiveMap`) are encoded to PNG with their
  sampler options; raw `{data, width, height}`/`ImageData` rows encode anywhere, other sources (ImageBitmap, canvas,
  image, video) and `maxTextureSize` resizing need `OffscreenCanvas` (browser or worker) and draw `flipY` textures back
  to glTF's row order.
- **Clips.** `animations` takes `{model, clips}` objects; an `@margoengine/animation` `Animation` is one. Tracks keep
  their interpolation (STEP, LINEAR, CUBICSPLINE); channels to nodes that are not exported are dropped.
- **Tree-shaking.** `exportModel` imports gltf-pro types only. The clip writer and the PNG encoder are loaded with
  `import()` only when `animations` are passed or an image must be encoded. Gzip (min, bare imports external):
  `/model` 5,175 + shared container 1,684 eager; clip writer chunk 539, PNG chunk 1,026.

| Option | Default |
| --- | --- |
| `binary` | `false`. `true` resolves to GLB bytes |
| `animations` | `[]`. `{model, clips}` per model, e.g. `[animation]` |
| `onlyVisible` | `true`. Hidden nodes and their subtrees are left out (a hidden skin joint throws) |
| `embedImages` | `true`. `false` keeps a loaded image's external `uri` |
| `maxTextureSize` | `Infinity`. Larger images are re-encoded as PNG at most this size (needs OffscreenCanvas) |
| `generator`, `embed`, `binUri` | as `exportGLTF` |

Measured (`node examples/package-benchmarks/exporters-model.mjs`, Node 24, `results/exporters-model.json`): DamagedHelmet
3,773,916 -> 3,773,808 bytes in 7.7 ms; RobotExpressive (14 clips, 2 skins, morphs) 463,988 -> 451,072 bytes in 3.6 ms;
2 x 500 instanced grids 132,056 -> 123,832 bytes in 2.6 ms (median of 7). Validator: the helmet keeps its one source
warning (normal map without tangents); the robot's 752 source errors (unnormalized weights) are gone and its 4 source
warnings (skinned meshes under transformed parents) remain; generated scenes are clean.

```ts
import {exportGLB, exportGLTF, exportSTL, exportOBJ, exportPLY} from '@margoengine/exporters';

// Whole engine scene, hierarchy kept, hidden meshes skipped.
const glb = exportGLB(engine);                                   // Uint8Array, save as .glb
const {text} = exportGLTF(engine);                               // .gltf with an embedded data URI
const {text: json, bin} = exportGLTF(engine, {embed: false, binUri: 'robot.bin'});
const part = exportGLB(engine, {root: arm, flatten: true, generator: 'My app'});

const stl = exportSTL(engine);                                   // binary Uint8Array
const stlText = exportSTL(engine, {binary: false});              // ASCII string
const {obj, mtl} = exportOBJ(engine, {materials: true, mtlName: 'robot.mtl'});
const ply = exportPLY(engine, {binary: true, colors: true});     // Uint8Array

// Plain data scenes carry what core Geometry cannot: UVs, tangents, vertex colors and textures.
const textured = exportGLB({nodes: [{
  name: 'panel', translation: [0, 1, 0], rotation: [0, 0, 0, 1],
  geometry: {positions, normals, uvs, tangents, colors, indices},
  material: {color: [1, 1, 1], roughness: 0.6, baseColorTexture: {image: pngBytes, mimeType: 'image/png'}},
  children: [],
}]});
```

## How it works

- **Scene walk.** An engine source is walked through `engineRuntime(engine)`: `meshes`, `store.parents`, `store.hidden` and the local transforms in `store.transforms` (translation, quaternion, scale). World matrices are recomputed in double precision from the parent chain, so export does not depend on a `render()` having run. Hidden meshes hide their descendants, as in the kernel.
- **Every Margo Engine mesh is a glTF node.** Transform-only meshes become empty nodes, so the hierarchy survives. With `flatten`, each drawable mesh is a root node with its world transform; when a parent chain with non-uniform scale produces shear, which glTF TRS cannot hold, that mesh's world transform is baked into its vertices (and winding is flipped for mirrors).
- **Deduplication.** One `Geometry` (or geometry data object) is written once: POSITION (with exact Float32 `min`/`max`), NORMAL, optional TANGENT, TEXCOORD_0 and COLOR_0, and indices. One glTF mesh is written per geometry and material pair, and one glTF material per `PbrMaterial`. Images are deduplicated by byte array.
- **Materials.** `PbrMaterial.data` maps to `pbrMetallicRoughness`: `baseColorFactor` is already linear, then `roughnessFactor`, `metallicFactor` and `doubleSided`. Material data adds emission, alpha mode and base color, metallic-roughness and normal textures.
- **Binary layout.** Each bufferView starts on a 4-byte boundary, the buffer length is a multiple of 4, GLB JSON is padded with spaces and BIN with zeros. Indices are 16-bit up to 65535 vertices (65535 itself is the restart value) and 32-bit above. Normals and tangents are normalized and tangent `w` is forced to +1 or -1, as the validator requires.
- **STL, OBJ, PLY** write world-space data. STL uses face normals from the transformed triangle. OBJ writes one `g` group per mesh, `v`/`vt`/`vn` and 1-based `f v/vt/vn` faces, with `vt` flipped to OBJ's v-up. The MTL has `Kd` and `Ke` in sRGB plus `Pr`, `Pm` and `d`. PLY merges all meshes into one vertex and face list, with optional 8-bit sRGB colors from vertex colors or the material.
- **Tree-shaking and SSR.** Each format is its own module and `sideEffects` is false, so importing only `exportSTL` leaves out the glTF writer. Nothing touches `window`, `document`, `navigator` or GPU globals, and base64 is done without `btoa` or `Buffer`.

## Options

| Option | Exporters | Default |
| --- | --- | --- |
| `onlyVisible` | all | `true`. Skip hidden meshes (or nodes with `visible: false`) and their descendants |
| `root` | all, engine source | Whole scene. A live mesh; it and its descendants are exported. In hierarchy mode the root keeps its local transform, as in Three.js |
| `geometryData` | all, engine source | None. A `Map`/`WeakMap` from core `Geometry` to richer `GeometryData` |
| `materialData` | all, engine source | None. A `Map`/`WeakMap` from `PbrMaterial` to `MaterialData` |
| `flatten` | glTF | `false`. World transforms on root nodes instead of the hierarchy |
| `generator` | glTF | `'Margo Engine exporters'`, written to `asset.generator` |
| `embed` | `exportGLTF` | `true`, base64 data URI. `false` returns `bin` for a separate file |
| `binUri` | `exportGLTF` | `'scene.bin'`, a relative file name |
| `binary` | STL, PLY | STL `true`, PLY `false` (ASCII, as in Three.js) |
| `name` | STL | ASCII `solid` name, or the 80-byte binary header (must not start with `solid`) |
| `materials`, `mtlName` | OBJ | `false`, `'scene.mtl'` |
| `colors` | OBJ, PLY | `false`. OBJ appends sRGB vertex colors to `v` lines; PLY writes uchar `red green blue` |

`GeometryData` is `{positions, normals, uvs?, tangents?, colors?, indices?}` with xyz, xyz, uv, xyzw and linear rgb or rgba per vertex. Inputs are validated: finite Float32 values, matching lengths, complete triangles, indices in range, colors in [0, 1], nonzero scales and quaternions, PNG or JPEG bytes that match `mimeType`, and textured materials only on geometry with UVs.

## Limits

`exportGLB`/`exportGLTF` (engine and data scenes): no animations, skins, morph targets, cameras, lights, instancing or KHR
material extensions (use `exportModel` for gltf-pro content). `exportModel`: no cameras or `KHR_lights_punctual`
lights, no Draco/meshopt output, no `KHR_materials_volume` thickness texture (gltf-pro does not draw it); materials-mesh
shading modes other than standard and basic (normal, matcap), custom blending and per-instance UV transforms have no
glTF form and are written as standard materials; UV1 of materials meshes (a copy of UV0) is not written; canvas
re-encoding goes through premultiplied alpha. The node hierarchy comes from the document (reparenting a model's
nodes in the engine is not followed). Neither writer emits sparse accessors or interleaved buffers. Texture samplers are fixed (linear, mipmapped, repeat). `exportGLTF` puts images in the buffer rather than separate image files. OBJ and PLY write `vn`/normals per vertex rather than deduplicating them. Node names are not made unique. The existing `@margoengine/gltf` loader accepts what these exporters write from an engine, but not vertex colors or textures, so data-scene exports that use them need a fuller loader.

## Tests

`npm test` in `packages/exporters` runs Node checks against a real Margo Engine `Engine` and Wasm transform kernel with a no-op renderer: every glTF and GLB is run through the official Khronos `gltf-validator` and must have zero errors and zero warnings; GLBs are re-imported with `@margoengine/gltf` and the kernel's world matrices, vertex data and materials are compared; deduplication, min/max and 4-byte alignment are checked; the Khronos Box and BoxTextured assets are round-tripped (BoxTextured with its PNG, UVs, tangents and colors); STL binary is checked byte by byte (80-byte header, count, 50-byte records) and ASCII STL, OBJ/MTL and both PLY encodings are parsed back by small reference parsers. The validator is the repository's `gltf-validator` dev dependency (`MARGOENGINE_EXPORTERS_TOOLS` points elsewhere); without it the validator tests are skipped.

`tests/model.test.js` round-trips `exportModel` through gltf-pro in Node (headless engine): DamagedHelmet and
RobotExpressive (node tree, transforms, skins, every decoded accessor and packed vertex byte for byte, normalized weights
within 1e-6, materials, image bytes and samplers, all 14 clips' keyframes byte for byte and every node's world matrix and
morph weights at five times per clip within 2e-5), an exported pose with edited morph weights, onlyVisible pruning, 2 x
50 `EXT_mesh_gpu_instancing` grids with tints and a reduced count, materials meshes (raw textures decoded back from the
PNG exactly, samplers, UV transform, BLEND/MASK, unlit, instanced with a mirrored instance) and `.gltf` output; every
output is validated with no error or warning beyond the source's. `node tests/png-browser.mjs` checks the canvas paths
(ImageBitmap sources, flipY, maxTextureSize) in headless Edge (`BROWSER_CHANNEL`); passed on Edge 155.

`npm run test:browser` (a real-GPU script, not in CI) builds a parented hierarchy with shared geometry, two materials and a hidden mesh in a real WebGPU engine (Playwright, honoring `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE` and `BROWSER_ARGS`), exports it, re-imports the GLB into the same engine and compares canvas pixels, world matrices and vertex data, checks for zero WebGPU validation errors, and validates the browser-made GLB, glTF and flattened GLB with the Khronos validator.

MIT licensed.

## USDZ for AR Quick Look

`exportUSDZ(engineOrDataScene, sceneOptions)` returns a `Uint8Array`: a static USDA root in an uncompressed ZIP with 64-byte-aligned entries. World-space positions, normals and reflected winding use the existing validated scene collector. Names are kept as display names; hidden descendants are skipped. The stage has a default prim, Y up, meter units, mesh extents and UsdPreviewSurface color/roughness/metalness/emission/opacity materials.

Import `exportUSDZ` from `@margoengine/exporters/usdz` to load only USDZ serialization and its shared scene collector in direct ESM applications. The existing package root uses the same function and remains supported.

Save as `.usdz`. A supported Apple device can open `<a rel="ar" href="model.usdz"><img src="preview.png" alt="View the model in AR"></a>`. No headset is required to generate or validate the file.

Hierarchy is baked into world-space meshes. Textures, vertex colors and alpha masks are rejected; animation, skins and morphs are not exported. Quick Look presentation remains untested on Apple hardware. `node --test tests/usdz.test.js` checks ZIP layout and loader round trips. Install the official `usd-core` wheel and run `python tests/validate-usdz.py model.usdz` for independent metadata, topology and available OpenUSD package/material validators.
