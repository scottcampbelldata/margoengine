# @margoengine/exporters

glTF 2.0 / GLB, STL, OBJ (with MTL), PLY and static USDZ export for Margo Engine scenes and plain geometry data.

Build from source with `npm run build` in `packages/exporters`.

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

## Loaded and materials model export

Use `exportModel` from `@margoengine/exporters/model` to save loaded glTF models or meshes made by `@margoengine/materials`, including their live textures:

```ts
import {exportModel} from '@margoengine/exporters/model';

const glb = await exportModel(mesh, {binary: true});
const {text, bin} = await exportModel(mesh, {embed: false});
```

Loaded glTF-pro models retain their scene cameras and existing directional, point and spot lights in GLB and JSON
output. `exportModel` writes live perspective/orthographic projections, light color/intensity/range and spot cones,
with node attachments, hierarchy and live transforms. Hidden nodes follow `onlyVisible`; a model with no cameras or
lights exports without camera arrays or punctual-light declarations. No additional light type is introduced.

Geometry groups remain primitives under one mesh node, with each group's material, textures and index range. Independent UV1 coordinates are written as `TEXCOORD_1`; referenced UV sets are retained even when every coordinate is zero. Texture UV selection and affine transforms use the live material rows, including changes made with `material.setUVTransform({texCoord: 1}, 'aoMap')`. An unused UV1 copy of UV0 is omitted.

Physical `Material` maps are saved to the matching glTF extensions: clearcoat factor, roughness and normal; transmission; sheen color and roughness; specular intensity and color; iridescence factor and thickness; anisotropy; and volume thickness. Each map keeps its live UV set and transform, sampler and original RGBA channels. A shared `Texture` is written once, including when several groups or physical lobes use it. Iridescence and anisotropy controls and the live volume thickness, attenuation color and attenuation distance are exported with the maps; infinite attenuation distance uses glTF's omitted default.

Live physical `Material.dispersion` and loaded native dispersion values are saved as `KHR_materials_dispersion`, including values above one. Explicit zero dispersion extensions remain present, and optional loaded dispersion metadata is retained when its material decoder is absent.

Live `side: 'back'` triangle materials are saved as ordinary front-only glTF materials with reversed triangle winding, negated base normals and negated morph normal deltas. Tangents and their handedness, UVs, morph position/tangent deltas, skins, node transforms and instance transforms are retained. Shared front/back geometry receives separate normal and index accessors; source arrays are unchanged. glTF has no back-only material flag, so reimported geometry keeps the visible surface through this bake. `side: 'double'` writes `doubleSided: true`; front-only and double-sided geometry follow their existing export path. Point and line geometry does not receive the triangle bake.

## How it works

Engine exports recognize primitives loaded by `@margoengine/gltf-pro` and `@margoengine/fbx`, without attaching core geometry. glTF/GLB retain all primitives on each node and their bind-pose skin/morph data; other formats write base geometry. Automatic export of PBR textures, material extensions, and more than four skin influences throws explicitly. An engine forest containing no supported mesh geometry also throws; visibility filtering and intentionally empty data scenes remain supported.

Engine export entrypoints also bake back-only optional PBR triangles by reversing winding and negating base and morph normals. This preserves their visible side in glTF, GLB, USDZ, OBJ, PLY and STL, including mirrored world transforms. Front-only and double-sided materials retain their existing geometry behavior.

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

`GeometryData` is `{positions, normals, uvs?, tangents?, colors?, indices?, joints?, weights?, morphs?}` with xyz, xyz, uv, xyzw and linear rgb or rgba per vertex. Inputs are validated: finite Float32 values, matching lengths, complete triangles, indices in range, colors in [0, 1], nonzero scales and quaternions, PNG or JPEG bytes that match `mimeType`, and textured materials only on geometry with UVs.

## Data-scene skin, morph and animation export

`exportGLTF` and `exportGLB` accept deformation data on plain scenes and retain bind-pose skin/morph data from loaded PBR engine nodes. Original animation clips are not forwarded from an engine; supply a data scene with `animations` to export clips. Keep the hierarchy when exporting deformation; `flatten: true` rejects skins, morphs and clips.

- A geometry's `joints` and `weights` supply four values per vertex and must appear together. Joint indices are unsigned 16-bit integers within the attached skin's joint list. Weights must be finite and nonnegative with a positive sum per vertex; the writer normalizes them into Float32 `WEIGHTS_0` alongside unsigned-short `JOINTS_0`.
- A mesh node's `skin` is `{name?, joints, inverseBindMatrices}`. `joints` references the actual `ExportNode` objects in the scene, with no duplicates and a common hierarchy root. `inverseBindMatrices` supplies sixteen finite, column-major affine values per joint. A joint skipped by `onlyVisible` or missing from the scene throws.
- Geometry `morphs` contain `{name?, positions, normals?, tangents?}`. Each array holds dense xyz deltas per base vertex; these deltas are not normalized. Morph tangents require base tangents, whose handedness remains unchanged. Names become `extras.targetNames`. Node `morphWeights` sets finite default weights and must match the target count; omitted weights default to zero.
- Scene `animations` contain `{name?, channels}`. Each channel is `{node, path, times, values, interpolation?}`, where `node` references an exported node and `path` is `translation`, `rotation`, `scale` or `weights`. Times are nonnegative seconds, strictly increasing after Float32 conversion. Values have three components for translation/scale, four for unit quaternion rotation, or one component per morph target for weights. Interpolation defaults to `LINEAR`; `STEP` and `CUBICSPLINE` are supported. Cubic channels need at least two keys and use in-tangent, value, out-tangent per key; only quaternion values must have unit length, not their tangents. Two channels in a clip cannot target the same node/path.

```ts
const joint = {name: 'joint'};
const mesh = {
  geometry: {positions, normals, joints, weights, morphs: [{name: 'raise', positions: deltas}]},
  skin: {joints: [joint], inverseBindMatrices},
  morphWeights: [0],
};
const glb = exportGLB({nodes: [mesh, joint], animations: [{name: 'Move', channels: [{
  node: joint, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0],
}]}]});
```

Load these GLBs with `@margoengine/gltf-pro` and attach `@margoengine/animation` for skinning, morphs and clip playback. Other export formats continue to write the static base geometry.

## Limits

The engine/data-scene `exportGLTF` and `exportGLB` entrypoints do not write cameras, lights, instancing extensions or
KHR material extensions; use `exportModel` for loaded glTF-pro camera/light attachments and PBR metadata. Export does
not produce Draco or meshopt compression, sparse accessors or interleaved buffers. Engine/data-scene skins support
four influences per vertex, and their texture samplers are fixed (linear, mipmapped, repeat). `exportGLTF` puts images
in the buffer rather than separate image files. OBJ and PLY write `vn`/normals per vertex rather than deduplicating
them. Node names are not made unique. The existing `@margoengine/gltf` loader accepts what these exporters write from
an engine, but data-scene exports with deformation, vertex colors or textures need the optional packages described above.

## Tests

`node --test packages/exporters/tests/scene-camera-lights*.test.js` from the repository root tests actual loaded
DirectionalLight, Cameras, PointLightIntensityTest and Box assets in GLB and JSON. It compares exported definitions,
node references and reloaded transforms; checks live edits, hidden nodes, multiple models and camera/light-free
scenes; and rejects invalid live metadata. With the official validator installed, every round trip requires zero
validator errors. GPU operations and PNG decoding use Node boundary shims; the loader and PBR model setup run unchanged.

`npm test` in `packages/exporters` runs Node checks against a real Margo Engine `Engine` and Wasm transform kernel with a no-op renderer: every glTF and GLB is run through the official Khronos `gltf-validator` and must have zero errors and zero warnings; GLBs are re-imported with `@margoengine/gltf` and the kernel's world matrices, vertex data and materials are compared; deduplication, min/max and 4-byte alignment are checked; the Khronos Box and BoxTextured assets are round-tripped (BoxTextured with its PNG, UVs, tangents and colors); STL binary is checked byte by byte (80-byte header, count, 50-byte records) and ASCII STL, OBJ/MTL and both PLY encodings are parsed back by small reference parsers. The validator is not a repository dependency: install it with `npm install gltf-validator` in a scratch folder and point `MARGOENGINE_EXPORTERS_TOOLS` at it (default `/tmp/claude-0/exporters-tools`); without it the validator tests are skipped.

`npm run test:browser` builds a parented hierarchy with shared geometry, two materials and a hidden mesh in a real WebGPU engine (Playwright, honoring `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE` and `BROWSER_ARGS`), exports it, re-imports the GLB into the same engine and compares canvas pixels, world matrices and vertex data, checks for zero WebGPU validation errors, and validates the browser-made GLB, glTF and flattened GLB with the Khronos validator.

MIT licensed.

## USDZ for AR Quick Look

`exportUSDZ(engineOrDataScene, sceneOptions)` returns a `Uint8Array`: a static USDA root in an uncompressed ZIP with 64-byte-aligned entries. World-space positions, normals and reflected winding use the existing validated scene collector. Names are kept as display names; hidden descendants are skipped. The stage has a default prim, Y up, meter units, mesh extents and UsdPreviewSurface color/roughness/metalness/emission/opacity materials.

Import `exportUSDZ` from `@margoengine/exporters/usdz` to load only USDZ serialization and its shared scene collector in direct ESM applications. The existing package root uses the same function and remains supported.

Save as `.usdz`. A supported Apple device can open `<a rel="ar" href="model.usdz"><img src="preview.png" alt="View the model in AR"></a>`. No headset is required to generate or validate the file.

Hierarchy is baked into world-space meshes. Textures, vertex colors and alpha masks are rejected; animation, skins and morphs are not exported. Quick Look presentation remains untested on Apple hardware. `node --test tests/usdz.test.js` checks ZIP layout and loader round trips. Install the official `usd-core` wheel and run `python tests/validate-usdz.py model.usdz` for independent metadata, topology and available OpenUSD package/material validators.
