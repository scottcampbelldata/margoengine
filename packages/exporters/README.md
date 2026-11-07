# @margoengine/exporters

Import `margoengine/exporters` from the `margoengine` package, or `@margoengine/exporters` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

glTF 2.0 / GLB, STL, OBJ (with MTL), PLY, static and [animated USDZ](#animated-usdz-margoengineexportersusdz-anim) static COLLADA 1.4.1 (`.dae`) and [3MF](#3mf-for-3d-printing-margoengineexportersthreemf) export for Margo Engine scenes
and plain geometry data, plus SHA-256 for checking exported files. [Compressed GLB files](#compressed-glb-files) are optional entries.

Build from source with `npm run build` in `packages/exporters`.

```ts
import {Engine, box, PbrMaterial} from 'margoengine/core';
import {exportGLB, exportGLTF, exportSTL, exportOBJ, exportPLY} from 'margoengine/exporters';
import {encodePNG} from 'margoengine/exporters/capture';

const engine = await Engine.create(document.querySelector<HTMLCanvasElement>('canvas')!);
const body = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color: '#84d6bd'}));
const arm = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color: '#d68484'}));
arm.setParent(body);

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
// One quad facing +z, with a 2 x 2 checker texture.
const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
const tangents = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
const colors = new Float32Array([1, 1, 1, 1, 0.5, 0.5, 1, 1, 1, 1, 0.5, 0.5]);
const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
const pngBytes = await encodePNG({width: 2, height: 2, data: new Uint8Array([
  255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
])});
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
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {exportModel} from 'margoengine/exporters/model';

const engine = await Engine.create(document.querySelector<HTMLCanvasElement>('canvas')!);
const model = await loadGLTF(engine, '/SciFiHelmet.glb');
const glb = await exportModel(model, {binary: true});
const {text, bin} = await exportModel(model, {embed: false});
```

Loaded glTF-pro models retain their scene cameras and existing directional, point and spot lights in GLB and JSON
output. `exportModel` writes live perspective/orthographic projections, light color/intensity/range and spot cones,
with node attachments, hierarchy and live transforms. Hidden nodes follow `onlyVisible`; a model with no cameras or
lights exports without camera arrays or punctual-light declarations. No additional light type is introduced.
`retainedVisibility: true` copies each written node's source `KHR_node_visibility`, as data-scene nodes'
`retainedVisibility` writes it (listed in `extensionsUsed`); runtime visibility is not read, so pass
`onlyVisible: false` to keep nodes the source hides.

Materials meshes use v-up UV orientation (v = 0 at the bottom of a `flipY` texture); glTF puts v = 0 at the
image's top. `exportModel` writes their UVs as `1 - v`, each texture's PNG with its GPU rows bottom first (a `flipY`
image as it is, raw pixel rows and `flipY: false` sources reversed) and each UV transform rewritten for the flipped v
(rotation negated, offset moved). Tangents are kept: their bitangent runs up the image in both conventions. So a
re-import draws the same pixels, normal maps included, and the PNGs open upright in other tools; the re-imported
model's UVs are glTF's (`1 - v` of the source).

Geometry groups remain primitives under one mesh node, with each group's material, textures and index range. Independent UV1 coordinates are written as `TEXCOORD_1`; referenced UV sets are retained even when every coordinate is zero. Texture UV selection and affine transforms use the live material rows, including changes made with `material.setUVTransform({texCoord: 1}, 'aoMap')`. An unused UV1 copy of UV0 is omitted.

Physical `Material` maps are saved to the matching glTF extensions: clearcoat factor, roughness and normal; transmission; sheen color and roughness; specular intensity and color; iridescence factor and thickness; anisotropy; and volume thickness. Each map keeps its live UV set and transform, sampler and original RGBA channels. A shared `Texture` is written once, including when several groups or physical lobes use it. Iridescence and anisotropy controls and the live volume thickness, attenuation color and attenuation distance are exported with the maps; infinite attenuation distance uses glTF's omitted default.

Live physical `Material.dispersion` and loaded native dispersion values are saved as `KHR_materials_dispersion`, including values above one. Explicit zero dispersion extensions remain present, and optional loaded dispersion metadata is retained when its material decoder is absent.

Live `side: 'back'` triangle materials are saved as ordinary front-only glTF materials with reversed triangle winding, negated base normals and negated morph normal deltas. Tangents and their handedness, UVs, morph position/tangent deltas, skins, node transforms and instance transforms are retained. Shared front/back geometry receives separate normal and index accessors; source arrays are unchanged. glTF has no back-only material flag, so reimported geometry keeps the visible surface through this bake. `side: 'double'` writes `doubleSided: true`; front-only and double-sided geometry follow their existing export path. Point and line geometry does not receive the triangle bake.

## How it works

Engine exports recognize primitives loaded by `@margoengine/gltf-pro` and `@margoengine/fbx`, without attaching core geometry. glTF/GLB retain all primitives on each node and their bind-pose skin/morph data. Formats with no skeleton write the shape the model has at its nodes' current pose: morph weights first, then the skin, with weights normalized. STL and PLY write a textured model's shape, and OBJ its shape, UVs and flat colors, plus its base color images [with `textures`](#loaded-models-as-obj-stl-and-ply). The other engine exports refuse PBR textures (a textured `createMesh` mesh included: use `exportModel`) and material extensions. More than four skin influences throws in every format. An engine forest containing no supported mesh geometry also throws; visibility filtering and intentionally empty data scenes remain supported.

Engine export entrypoints also bake back-only optional PBR triangles by reversing winding and negating base and morph normals. This preserves their visible side in glTF, GLB, USDZ, OBJ, PLY and STL, including mirrored world transforms. Front-only and double-sided materials retain their existing geometry behavior.

- **Scene walk.** An engine source is walked through `engineRuntime(engine)`: `meshes`, `store.parents`, `store.hidden` and the local transforms in `store.transforms` (translation, quaternion, scale). World matrices are recomputed in double precision from the parent chain, so export does not depend on a `render()` having run. Hidden meshes hide their descendants, as in the kernel.
- **Every Margo Engine mesh is a glTF node.** Transform-only meshes become empty nodes, so the hierarchy survives. With `flatten`, each drawable mesh is a root node with its world transform; when a parent chain with non-uniform scale produces shear, which glTF TRS cannot hold, that mesh's world transform is baked into its vertices (and winding is flipped for mirrors).
- **Deduplication.** One `Geometry` (or geometry data object) is written once: POSITION (with exact Float32 `min`/`max`), NORMAL, optional TANGENT, TEXCOORD_0 and COLOR_0, and indices. One glTF mesh is written per geometry and material pair, and one glTF material per `PbrMaterial`. Images are deduplicated by byte array.
- **Materials.** `PbrMaterial.data` maps to `pbrMetallicRoughness`: `baseColorFactor` is already linear, then `roughnessFactor`, `metallicFactor` and `doubleSided`. Material data adds emission, alpha mode, base color, metallic-roughness, normal, occlusion and emissive textures, and `KHR_materials_transmission`, `KHR_materials_ior` and `KHR_materials_emissive_strength`.
- **Binary layout.** Each bufferView starts on a 4-byte boundary, the buffer length is a multiple of 4, GLB JSON is padded with spaces and BIN with zeros. Indices are 16-bit up to 65535 vertices (65535 itself is the restart value) and 32-bit above. Normals and tangents are normalized and tangent `w` is forced to +1 or -1, as the validator requires.
- **STL, OBJ, PLY** write world-space data. STL and PLY stand a Y-up scene on Z up, as the tools that read them expect (`upAxis`); OBJ stays Y up, which its readers expect. STL uses face normals from the transformed triangle. OBJ writes one `g` group (or `o` object) per mesh, `v`/`vt`/`vn` and 1-based `f v/vt/vn` faces, with `vt` flipped to OBJ's v-up. The MTL has `Kd` and `Ke` in sRGB plus `Pr`, `Pm`, `d` and optional `map_Kd`/`map_d`. PLY merges all meshes into one vertex and face list, with optional 8-bit sRGB colors from vertex colors or the material.
- **Tree-shaking and SSR.** Each format is its own module and `sideEffects` is false, so importing only `exportSTL` leaves out the glTF writer. Nothing touches `window`, `document`, `navigator` or GPU globals, and base64 is done without `btoa` or `Buffer`.

## Options

| Option | Exporters | Default |
| --- | --- | --- |
| `onlyVisible` | all | `true`. Skip hidden meshes (or nodes with `visible: false`) and their descendants |
| `root` | all, engine source | Whole scene. A live mesh; it and its descendants are exported. In hierarchy mode the root keeps its local transform |
| `geometryData` | all, engine source | None. A `Map`/`WeakMap` from core `Geometry` to richer `GeometryData` |
| `materialData` | all, engine source | None. A `Map`/`WeakMap` from `PbrMaterial` to `MaterialData` |
| `flatten` | glTF | `false`. World transforms on root nodes instead of the hierarchy |
| `generator` | glTF | `'Margo Engine exporters'`, written to `asset.generator` |
| `maxBinaryBytes`, `maxBytes` | `exportGLB` | 4,294,967,295 (the GLB format limit). Output limits; see [GLB size limits](#glb-size-limits) |
| `embed` | `exportGLTF` | `true`, base64 data URI. `false` returns `bin` for a separate file |
| `binUri` | `exportGLTF` | `'scene.bin'`, a relative file name |
| `binary` | STL, PLY | STL `true`, PLY `false` (ASCII) |
| `name` | STL | ASCII `solid` name, or the 80-byte binary header (must not start with `solid`) |
| `upAxis` | STL, PLY | `'y'`, the scene's up axis. Slicers, CAD tools and Blender read these files with Z up, so `'y'` turns the scene to stand up in them; `'z'` writes its coordinates as they are |
| `materials`, `mtlName` | OBJ | `false`, `'scene.mtl'` |
| `colors` | OBJ, PLY | `false`. OBJ appends sRGB vertex colors to `v` lines; PLY writes uchar `red green blue` |
| `colorSpace` | OBJ | `'srgb'`. `'linear'` writes the vertex colors unconverted |
| `textures`, `texturePrefix` | OBJ | `false`, `''`. With `materials`, writes `map_Kd` (plus `map_d` for MASK/BLEND) and returns the images in `textures`. A `baseColorTextureTransform` goes into the `vt` lines, as MTL has no rotation |
| `groups` | OBJ | `true`, one `g` per mesh; `false` writes `o` objects |
| `mergeVertices` | OBJ | `false`. Welds a mesh's corners whose position, uv, normal and written color agree within 1e-5 |
| `usemtl` | OBJ | `false`. Writes `usemtl <material name>` per mesh without `materials`: one group per palette slot, no `mtllib` and no MTL |
| `shareVertices` | OBJ | `true`, faces share the mesh's indexed corners. `false` gives every face its own `v`/`vt`/`vn` corners (not with `mergeVertices`) |
| `scale` | OBJ | `1`. Multiplies every position |

`GeometryData` is `{positions, normals, uvs?, tangents?, colors?, indices?, faceSizes?, joints?, weights?, morphs?}` with xyz, xyz, uv, xyzw and linear rgb or rgba per vertex. `uvs` follow glTF (v = 0 at the image's top, images as encoded): a materials mesh's v-up UVs go in as `1 - v`. `faceSizes` lists corners per face in index order: 3 for a triangle, 4 for the next two triangles when they form a quad (sharing an edge, as (a, b, c), (a, c, d)); OBJ and DAE write those quads as 4-corner faces, the other formats write the triangles. Inputs are validated: finite Float32 values, matching lengths, complete triangles, indices in range, colors in [0, 1], nonzero scales (or [0, 0, 0], below) and quaternions, PNG or JPEG bytes that match `mimeType`, and textured materials only on geometry with the UV set they sample.

### Retaining hidden nodes

Data-scene `ExportNode.retainedVisibility` writes `KHR_node_visibility` without filtering the node, geometry or descendants. Omit it for the default visible fallback; explicitly set `false` for a hidden collision helper whose geometry and socket nodes must survive export. The extension is listed in `extensionsUsed`, not `extensionsRequired`. Existing `visible: false` still controls `onlyVisible` filtering. Retained visibility needs hierarchy export; `flatten: true` rejects it with a `TypeError`.

```ts
import {exportGLB} from 'margoengine/exporters';

// A one-triangle collision helper.
const geometry = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
};
const glb = exportGLB({nodes: [{name: 'Helper-colonly', geometry, retainedVisibility: false}]});
```

## Data-scene skin, morph and animation export

`exportGLTF` and `exportGLB` accept deformation data on plain scenes and retain bind-pose skin/morph data from loaded PBR engine nodes. Original animation clips are not forwarded from an engine; supply a data scene with `animations` to export clips. Keep the hierarchy when exporting deformation; `flatten: true` rejects skins, morphs and clips.

- A geometry's `joints` and `weights` supply four values per vertex and must appear together. Joint indices are unsigned 16-bit integers within the attached skin's joint list. Weights must be finite and nonnegative with a positive sum per vertex; the writer normalizes them into Float32 `WEIGHTS_0` alongside unsigned-short `JOINTS_0`.
- A mesh node's `skin` is `{name?, joints, inverseBindMatrices}`. `joints` references the actual `ExportNode` objects in the scene, with no duplicates and a common hierarchy root. `inverseBindMatrices` supplies sixteen finite, column-major affine values per joint. A joint skipped by `onlyVisible` or missing from the scene throws.
- Geometry `morphs` contain `{name?, positions, normals?, tangents?}`. Each array holds dense xyz deltas per base vertex; these deltas are not normalized. Morph tangents require base tangents, whose handedness remains unchanged. Names become `extras.targetNames`. Node `morphWeights` sets finite default weights and must match the target count; omitted weights default to zero.
- Scene `animations` contain `{name?, channels}`. Each channel is `{node, path, times, values, interpolation?}`, where `node` references an exported node and `path` is `translation`, `rotation`, `scale` or `weights`. Times are nonnegative seconds, strictly increasing after Float32 conversion. Values have three components for translation/scale, four for unit quaternion rotation, or one component per morph target for weights. Interpolation defaults to `LINEAR`; `STEP` and `CUBICSPLINE` are supported. Cubic channels need at least two keys and use in-tangent, value, out-tangent per key; only quaternion values must have unit length, not their tangents. Two channels in a clip cannot target the same node/path.
- Scene `materialAnimations` contain `{name?, channels}` and animate base-color UVs (a tile atlas cel, a scrolling texture) through `KHR_animation_pointer`. Each channel is `{material, texture: 'baseColorTexture', property: 'offset' | 'scale', times, values, interpolation: 'STEP'}`: `material` is the `MaterialData` object of an exported textured material that sets `baseColorTextureTransform: {offset, scale}` (written as a required `KHR_texture_transform`), and `values` hold two Float32 values per key. Material clips follow the node clips; a clip cannot target one material property twice, and `flatten: true` rejects them. `createMaterialAnimation(model)` in `@margoengine/animation` plays them back.

```ts
import {exportGLB, type ExportNode} from 'margoengine/exporters';

// One triangle bound to one joint, with a morph target that raises its top vertex.
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
const joints = new Uint16Array(12);                             // four joint indices per vertex, all joint 0
const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
const deltas = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0.5, 0]);
const inverseBindMatrices = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const joint: ExportNode = {name: 'joint'};
const mesh: ExportNode = {
  geometry: {positions, normals, joints, weights, morphs: [{name: 'raise', positions: deltas}]},
  skin: {joints: [joint], inverseBindMatrices},
  morphWeights: [0],
};
const glb = exportGLB({nodes: [mesh, joint], animations: [{name: 'Move', channels: [{
  node: joint, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0],
}]}]});
```

Load these GLBs with `@margoengine/gltf-pro` and attach `@margoengine/animation` for skinning, morphs and clip playback. Other export formats continue to write the static base geometry.

## Loaded models as OBJ, STL and PLY

A model from `loadGLTF` exports with the shape it has now: skinned parts sit on their bones, and morph weights apply.
Pass the engine, which writes every mesh in it.

```ts
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
import {exportOBJ, exportPLY, exportSTL} from 'margoengine/exporters';

const engine = await Engine.create(document.querySelector<HTMLCanvasElement>('canvas')!);
await loadGLTF(engine, '/Fox.glb');

const print = exportSTL(engine);                       // stands on Z up, for a slicer
const scan = exportPLY(engine, {upAxis: 'z'});         // coordinates as they are
const {obj, mtl, textures} = exportOBJ(engine, {materials: true, textures: true, mtlName: 'fox.mtl'});
for (const [path, bytes] of textures) console.log(path, bytes.length); // save each beside the OBJ
```

With `textures`, each base color image is written as the model file holds it, and the UV set it samples becomes the
OBJ's one UV set. An image outside the model file, one in another format, or a live `Material`'s throws, as dropping it
would lose what was asked for: pass `textures: false` for the shape and colors, or use `exportModel`. OBJ has no place for
the other PBR maps and extensions, so they are left out. MTL multiplies `Kd` by `map_Kd`, and so a tinted texture needs
a reader that does the same: Blender's importer shows the texture alone.

## OBJ textures and quads

```ts
import {exportOBJ, type ExportScene} from 'margoengine/exporters';
import {encodePNG} from 'margoengine/exporters/capture';

// Downloads a file in the browser.
const save = (name: string, data: Uint8Array | string) => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([typeof data === 'string' ? data : data.slice()]));
  link.download = name;
  link.click();
};
const tileset = await encodePNG({width: 1, height: 1, data: new Uint8Array([200, 120, 60, 255])});
const scene: ExportScene = {nodes: [{name: 'Floor', geometry: {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
  indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  faceSizes: [4],
}, material: {baseColorTexture: {image: tileset, mimeType: 'image/png', name: 'tileset'}}}]};
const {obj, mtl, textures} = exportOBJ(scene, {
  materials: true, mtlName: 'level.mtl', textures: true, texturePrefix: 'textures/',
  colors: true, colorSpace: 'linear', mergeVertices: true, groups: false, scale: 16,
});
save('level.obj', obj);
save('level.mtl', mtl!);                                   // written with materials: true
for (const [path, bytes] of textures) save(path, bytes); // e.g. 'textures/tileset.png', relative to the OBJ
```

Texture files are named from `TextureData.name` (unsafe characters become `_`, a trailing `.png`/`.jpg` is dropped)
or `texture_<n>`, with `.png` or `.jpg` from the `mimeType`; one image's bytes become one file, and a name already
taken gets `_2`, `_3`. The files are the `TextureData` bytes as given. `texturePrefix` may hold letters, digits,
`_ . - /`.

The MTL writes `Kd`, `Ks`/`Ns` (Phong), `Ke`, `Pr`/`Pm`, `d` (1 for opaque materials) and `illum` (0 unlit, 1 Lambert,
2 otherwise). A MASK or BLEND material's texture is also its `map_d`; with `opacityMaps: true` it gets its own
`<texture>-opacity.png` instead (`map_d -imfchan r`), since most readers ignore a color file's alpha there.
`exportOBJ` names those files in `opacityMaps`; `await writeOpacityMaps(result)` encodes each from its PNG's alpha
into `result.textures`.

## COLLADA (.dae)

`exportDAE(engineOrDataScene, options)` from `@margoengine/exporters/dae` (or the package root) returns
`{dae, textures}`: a COLLADA 1.4.1 document (Y up, meters) and its image files keyed by their path relative to the
`.dae`. Options are the scene options plus `colorSpace` (`'srgb'` default or `'linear'`, for vertex colors) and
`texturePrefix`, named as for OBJ.

```ts
import type {ExportScene} from 'margoengine/exporters';
import {exportDAE} from 'margoengine/exporters/dae';

// Downloads a file in the browser.
const save = (name: string, data: Uint8Array | string) => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([typeof data === 'string' ? data : data.slice()]));
  link.download = name;
  link.click();
};
const scene: ExportScene = {nodes: [{name: 'Tile', geometry: {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
}, material: {color: [0.8, 0.5, 0.2], shading: 'lambert'}}]};
const {dae, textures} = exportDAE(scene, {texturePrefix: 'textures/'});
save('level.dae', dae);
for (const [path, bytes] of textures) save(path, bytes);
```

- **Hierarchy.** Every node is a `<node>` with its local transform as a row-major `<matrix>`; hidden nodes follow
  `onlyVisible`.
- **Geometry.** One `<geometry>` per shared geometry: positions, normals, `TEXCOORD` (t = 1 - v) and `COLOR` sources,
  all indexed by one offset, as `<triangles>`, or `<polylist>` when `faceSizes` marks quads.
- **Materials.** One effect per shared material: `<constant>` for `unlit`, `<lambert>` for `shading: 'lambert'`,
  `<phong>` with the material's `specular` and `shininess` for `shading: 'phong'`. A standard material becomes
  `<lambert>` at roughness 1 and metalness 0, otherwise an equivalent `<phong>` (specular F0 = mix(0.04, base,
  metalness), shininess 2 / roughness^4 - 2). The base
  color texture, when present, replaces the base color through a `surface`/`sampler2D` pair carrying the texture's
  filters and wrap modes; MASK and BLEND write `<transparent opaque="A_ONE">` from the texture or color alpha.
  Effect colors are sRGB. Instances bind the material and `UVSET0`.
- **Not written.** Static pose only, as Crocotile: skins, morph targets, animation, cameras and lights are not
  exported (skinned and morphed meshes keep their base geometry). Metallic-roughness and normal textures, emissive
  textures, double-sidedness and a second UV set are not written either. An empty or fully hidden scene throws.

## Data-scene samplers, unlit materials, cameras and lights

`TextureData` takes `magFilter` and `minFilter` (`'nearest'` or `'linear'`, default linear), `mipmaps` (default true)
and `wrapS`/`wrapT` (`'repeat'`, `'clamp'` or `'mirror'`, default repeat). Equal samplers are written once; one image's
bytes are shared by textures with different samplers. `MaterialData.unlit: true` writes `KHR_materials_unlit`.
`MaterialData.shading: 'lambert' | 'phong'` (with `specular`, default sRGB #111111, and `shininess`, default 30) is the
lighting model as `@margoengine/materials` names it: COLLADA writes the matching effect, MTL `illum 1` or `Ks`/`Ns`/
`illum 2`, and glTF metalness 0 with roughness 1 (lambert) or `(2 / (shininess + 2))^(1/4)` (phong). A node's
`camera` (`{type, perspective: {yfov, znear, zfar?, aspectRatio?}}` or `{type, orthographic: {xmag, ymag, znear, zfar}}`)
becomes a glTF camera and its `light` (`{type: 'directional' | 'point' | 'spot', color, intensity, range?,
innerConeAngle?, outerConeAngle?}`) a `KHR_lights_punctual` light; both face the node's -Z and shared objects are
written once. A gltf-pro `GLTFCamera` or `GLTFLight` record fits as it is. `flatten: true` rejects cameras and lights.
Only the glTF writers use cameras and lights.

```ts
import {exportGLB, type TextureData} from 'margoengine/exporters';
import {encodePNG} from 'margoengine/exporters/capture';

const pngBytes = await encodePNG({width: 1, height: 1, data: new Uint8Array([90, 160, 255, 255])});
const geometry = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 0, 0]),
};
const pixels: TextureData = {image: pngBytes, mimeType: 'image/png', magFilter: 'nearest', minFilter: 'nearest', mipmaps: false};
const glb = exportGLB({nodes: [
  {geometry, material: {baseColorTexture: pixels, unlit: true}},
  {translation: [0, 3, 0], light: {type: 'point', color: [1, 0.9, 0.7], intensity: 40, range: 10}},
  {translation: [0, 1, 6], camera: {type: 'perspective', perspective: {yfov: 0.8, znear: 0.1}}},
]});
```

### Pixel-art sampling

`pixelArt` on the glTF, GLB, COLLADA and `exportModel` options writes every sampler as pixel art: nearest
magnification and minification with no mips (`true` or `{mipmaps: 'none'}`, glTF NEAREST/NEAREST) or with mips picked
nearest (`{mipmaps: 'nearest'}`, NEAREST/NEAREST_MIPMAP_NEAREST); `wrap` replaces both wrap modes when given.
`pixelArtTexture(texture, sampling)` does the same for one `TextureData`. Each target reads it its own way (measured
on this PC, `examples/package-benchmarks/results/pixel-art-native.json`):

| Target | What the export gives it | What to add |
| --- | --- | --- |
| Godot 4.7 | glTF import maps NEAREST to `TEXTURE_FILTER_NEAREST` and NEAREST_MIPMAP_NEAREST to `NEAREST_WITH_MIPMAPS`; embedded images stay uncompressed RGBA8 | nothing |
| Unreal 5.8 | Interchange keeps NEAREST as `TF_NEAREST` but still builds mips with lossy compression, and reads NEAREST_MIPMAP_NEAREST as linear | `createUnrealPixelArtScript` (`unreal-pixel-art`) after import |
| Unity 6 (glTFast) | filters come from the glTF samplers; the exact profile (`unity`) already enforces Point with no mips | `createUnityPixelArtPostprocessor` (`unity-pixel-art`) for loose PNGs |

```ts
import {exportGLB, type GeometryData, type TextureData} from 'margoengine/exporters';
import {createUnrealPixelArtScript} from 'margoengine/exporters/unreal-pixel-art';
import {createUnityPixelArtPostprocessor} from 'margoengine/exporters/unity-pixel-art';

declare const geometry: GeometryData, pixels: TextureData;
const tiles = exportGLB({nodes: [{geometry, material: {baseColorTexture: pixels}}]}, {pixelArt: {mipmaps: 'nearest'}});
// Unreal: run after the Interchange import, then call apply_pixel_art("/Game/Tiles").
const unrealPython = createUnrealPixelArtScript({mipmaps: 'nearest'});
// Unity: save as Assets/Editor/PixelArtTextures.cs; textures imported under Assets/Tiles get the settings.
const unityCSharp = createUnityPixelArtPostprocessor({folder: 'Assets/Tiles'});
```

The Unreal script sets the "2D Pixels (unfiltered)" texture group, `TF_NEAREST`, `TMGS_NO_MIPMAPS` (or
`TMGS_SIMPLE_AVERAGE` for nearest mips), uncompressed `TC_EDITOR_ICON` storage and `TLCA_NONE`, reads each setting
back and saves; the Unity postprocessor sets Point filtering, the mip policy, no compression, no mip streaming and no
power-of-two rescale, and leaves wrap as imported.

## Rich data scenes: multi-material meshes, extras, PBR textures and lightmaps

Plain data scenes carry what a voxel or game-asset pipeline writes into a standard glTF, all checked by the Khronos
validator in the tests:

- **Multi-material meshes.** A node's `primitives` (instead of `geometry` and `material`) is a list of
  `{geometry, material?, indices?, extras?}`. Primitives that share one geometry object and give their own `indices`
  write its vertex attributes once and an index list each: one palette model split by material is one mesh, one vertex
  set. Nodes that share a `primitives` array share the glTF mesh; `meshName` and `meshExtras` name and annotate it.
- **Extras at every scope.** `extras` on the scene (the document root), `scene` (`{name, extras}`), `asset`
  (`{copyright, extras}`), nodes, meshes (`meshExtras`), primitives, materials, textures, skins, animations, cameras
  and lights. Extras are JSON: plain objects, arrays, strings, finite numbers, booleans and null, copied at export;
  typed arrays, class instances, non-finite numbers and cycles throw instead of changing silently.
- **Textures and extensions.** `MaterialData` adds `occlusionTexture` (with `occlusionStrength`), `emissiveTexture`
  (multiplied by `emissive`, so set it to [1, 1, 1]), `normalScale`, and `transmission`, `ior` and `emissiveStrength`,
  written as `KHR_materials_transmission`, `KHR_materials_ior` and `KHR_materials_emissive_strength` when they differ
  from glTF's defaults. A texture's `texCoord: 1` samples `uvs1` (`TEXCOORD_1`).
- **Indexed palette textures.** `await paletteTexture(rgba)` lays out RGBA8 palette entries one per texel in the
  smallest square power-of-two PNG, sampled NEAREST without mipmaps and clamped, and returns each entry's texel-centre
  UV, so a face picks its exact palette colour.
- **Exact JSON numbers.** Node translations, rotations, scales and matrices, and material factors
  (`baseColorFactor`, `metallicFactor`, `roughnessFactor`, `emissiveFactor`), are JSON numbers in glTF, so the writer
  keeps every finite JavaScript number as given: `[16777217, -16777217, 0.1]` and a scale of `1e-50` come out as they
  went in (no Float32 rounding, underflow or range limit). A rotation is written as given when it is a unit quaternion
  to within 1e-5 and otherwise scaled to unit length, its sign kept. Transform fields a data node sets are written even
  when they equal glTF's default. Vertex data, indices, inverse bind matrices and animation keys stay Float32 (or
  integer) accessors, as glTF requires.
- **Node matrices and collapsed nodes.** `matrix` (column-major, affine, without shear: glTF forbids sheared node
  matrices) replaces translation, rotation and scale on a node that is not animated; it is written exactly as given.
  A scale of [0, 0, 0] collapses a node: glTF keeps it (a hidden cel, shown later by a scale channel), the mesh-only
  formats leave it out. Any other scale with a 0 component is refused; tiny nonzero and negative scales are kept.
- **Skins** name their `skeleton` root (checked to be an ancestor of every joint).
- **Lightmaps.** glTF has no standard lightmap material slot, and this writer does not invent an extension. A scene's
  `lightmap: {texture, texCoord?, key?, extras?}` writes the texture into the document and records it under the root
  `extras[key]` (default `'lightmap'`) as `{texture: <index>, texCoord, ...extras}`; every drawn mesh needs that UV
  set (default `uvs1`). Standard viewers ignore it; an import script binds it. `emission` (a second texture),
  `lightmapScale` and `emissionScale` (each at least 1, as `@margoengine/lightmap` returns them) are added to the
  record, so a game can reload the finished lighting.

```ts
import {exportGLB, paletteTexture} from 'margoengine/exporters';

import {encodePNG} from 'margoengine/exporters/capture';

const rgbaBytes = new Uint8Array([200, 60, 40, 255, 120, 200, 255, 128]); // two palette entries
const palette = await paletteTexture(rgbaBytes);             // {texture, size, uvs}
// A quad of two triangles: the first solid (entry 0), the second glass (entry 1).
const [u0, v0, u1, v1] = palette.uvs;
const geometry = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array(Array.from({length: 6}, () => [0, 0, 1]).flat()),
  uvs: new Float32Array([u0, v0, u0, v0, u0, v0, u1, v1, u1, v1, u1, v1]),
  uvs1: new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
  colors: new Float32Array(18).fill(1),
  indices: new Uint16Array([0, 1, 2, 3, 4, 5]),
};
const solidTriangles = new Uint16Array([0, 1, 2]);
const glassTriangles = new Uint16Array([3, 4, 5]);
const lightmapPNG = {image: await encodePNG({width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255])}),
  mimeType: 'image/png' as const};
const glb = exportGLB({
  nodes: [{name: 'Body', extras: {app: {modelId: 'body'}}, meshName: 'Body_Mesh', primitives: [
    {geometry, indices: solidTriangles, material: {baseColorTexture: palette.texture, emissive: [1, 1, 1],
      emissiveTexture: palette.texture, emissiveStrength: 4}},
    {geometry, indices: glassTriangles, material: {baseColorTexture: palette.texture, alphaMode: 'BLEND',
      transmission: 0.8, ior: 1.33}},
  ]}],
  extras: {app: {source: 'studio'}},
  lightmap: {texture: lightmapPNG, key: 'appLightmap', extras: {encoding: 'linear', scale: 2}},
});
```

## Held-key animation: cels, instances and sampled clocks

Helpers in the main entry turn document frames into standard glTF channels for an `ExportScene` animation. Each sets
the nodes it animates to their first key (what a viewer that does not play the clip shows) and returns the channels.
The rest pose keeps the exact numbers given (a placement matrix's translation included); the channel keys are Float32
accessors, so for example 16,777,217 is a key of 16,777,216.

| Function | Writes |
| --- | --- |
| `frameTimes({fps, frames, end?})` | Float32 key times: `(frame - frames[0]) / fps` per key, then `end` (default last + 1), so the last key holds until the clip ends. Throws when two times collapse in Float32 |
| `sampleFrames(first, last, fps, maxFrames = 4096)` | A clip of every whole frame, for motion that changes between keys (local object clocks) |
| `animateTransforms(node, clip, poses, {interpolation?, paths?})` | Translation, rotation and scale channels (or the `paths` given, e.g. a translation-only parent over a rotation-and-scale child); quaternions normalized and kept on one hemisphere |
| `animateCels(cels, clip, shown)` | Held topology-changing geometry: `cels` are the distinct banks (`@margoengine/voxel-edit`'s `packFrames` gives them), `shown[k]` the bank visible from key `k` or -1; STEP scale channels show one child at a time, so a bank used at many keys is written once |
| `animatePlacements(node, clip, matrices)` | A retained instance's placement per key from its local matrix, or `null` where it is hidden (scale 0); STEP channels; throws on shear |

```ts
import {animateCels, animateTransforms, exportGLB, type ExportNode, type ExportPrimitive} from 'margoengine/exporters';

// Two geometry banks: a triangle and a taller triangle.
const triangle = (height: number): ExportPrimitive[] => [{geometry: {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, height, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
}}];
const bank0 = triangle(1), bank1 = triangle(2);
const clip = {fps: 12, frames: [0, 4, 8], end: 12};
const cels: ExportNode[] = [{name: 'Prop_Cel1', primitives: bank0}, {name: 'Prop_Cel2', primitives: bank1}];
const prop: ExportNode = {name: 'Prop', children: cels};
const poses = [{translation: [0, 0, 0]}, {translation: [0, 1, 0]}, {translation: [0, 0, 0]}];
const channels = [...animateCels(cels, clip, [0, 1, 0]), ...animateTransforms(prop, clip, poses)];
const glb = exportGLB({nodes: [prop], animations: [{name: 'Clip', channels, extras: {fps: 12}}]});
```

## Appending to an existing GLB

`splitGLB(bytes)` checks a GLB (header, chunk order and alignment, UTF-8 JSON, buffer 0 against the BIN chunk) and
returns `{json, bin, chunks}`, where `chunks` are the chunks glTF 2.0 does not define, in order; `joinGLB(parts)`
writes them back (a round trip is byte-identical). `splitGLB(bytes, {copy: false})` returns `bin` and the chunks as
views into `bytes` (no second copy of a large file), and `{parse}` replaces the default parser (`JSON.parse` without
`__proto__`, `constructor` and `prototype` keys) with a stricter one. `appendGLBMeshes(bytes, meshes)` adds `{name,
positions, indices, volume?, extras?, meshExtras?}` triangle meshes as root nodes of the active scene and keeps everything else: existing
JSON members, extensions and extras, the BIN bytes, and every further chunk. Names must not clash with an existing node
(importers match them); every triangle needs area, and `volume: true` requires points off one plane, as convex
collision hulls do. Existing scene roots, node children and the active scene index must resolve to distinct existing
nodes, checked even when nothing is appended, so a malformed file is refused rather than passed on. The naming
convention (a Godot `-colonly` suffix, for example) is the caller's.

`readAccessor(parts, index)` reads one accessor of a split GLB back as plain data: `{values, count, width,
componentType, normalized}`, with strided and matrix-padded elements packed, sparse values applied and integer values as
stored. Checkers that read exported files back use it with `splitGLB(bytes, {copy: false})`, so no second copy of the
BIN is made. Only buffer 0 (the BIN chunk) is read; anything out of bounds or non-finite throws.

```ts
import {appendGLBMeshes, exportGLB} from 'margoengine/exporters';

const glb = exportGLB({nodes: [{name: 'Body', geometry: {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
}}]});
// A tetrahedron hull.
const hull = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
const indices = new Uint16Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
const withColliders = appendGLBMeshes(glb, [
  {name: 'Body-colonly', positions: hull, indices, volume: true, extras: {role: 'collision'}},
]);
```

### Importer naming (`@margoengine/exporters/import-names`)

Godot reads collision roles from node name suffixes (`-col`, `-convcol`, `-colonly`, `-convcolonly`; the Unity
import profile reads the same ones) and loops clips whose names end in `-loop`. `collisionTag(name)` returns a
name's suffix or null, `collisionBase(name)` strips every suffix, and `withCollisionTag(name, tag)` replaces them
with one (or none for null). `clipImportName(name, loop)` removes leading and trailing `loop`/`cycle` tokens and adds
`-loop` when `loop` is true, so a clip loops exactly when asked. `godotImportedNodeName(name, hasMesh)` gives the node name
Godot keeps after suffix import (`Wall-col` becomes `Wall`), and `GODOT_SUFFIX_IMPORT_SETTINGS` is a GLB `.import` file
that turns suffix import on and keeps meshes uncompressed.

## Godot import bundle (`@margoengine/exporters/godot`)

`createGodotImportBundle(glb, options)` returns owned files around an already encoded Margo GLB. It does not rewrite
the GLB, run Godot or change the project settings. Copy the returned folder into the root of an existing project
without renaming it; the seed `.glb.import` refers to the generated script at that fixed `res://` location. Godot
creates its own UID and cache paths. The caller can package the entries with the existing public ZIP encoder:

```ts
import {exportGLB} from 'margoengine/exporters';
import {createGodotImportBundle} from 'margoengine/exporters/godot';
import {encodeZIP} from 'margoengine/exporters/capture';

const glb = exportGLB({nodes: [
  {name: 'Waystone', extras: {id: 'waystone'}, geometry: {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  }},
  {name: 'Waystone-convcol', extras: {id: 'exported-helper-id'}, retainedVisibility: false, geometry: {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint16Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  }},
]});
const bundle = await createGodotImportBundle(glb, {
  folder: 'margo_exports/waystone',
  convexHelperIds: ['exported-helper-id'], // default []
  // fps: 24, // required when exported clips have mixed or missing extras.fps
});
const zip = await encodeZIP(bundle.entries);
```

`flipbooks: { appName, bindings }` adds `flipbook-player.gd` (the `godot-flipbook` player), `flipbook-bindings.json` and
`scene.tscn`, which runs the player with the GLB instanced as `Geometry`; bindings name surfaces by path from there.
`files` adds the application's own files to the folder and the manifest. Clips may animate nodes or, through
`KHR_animation_pointer`, material properties such as UV flipbooks; every STEP key must sit on the `fps` grid. The seed
turns on name and node-type suffixes, which `-col`/`-convcol` collision nodes need.

The optional module emits `model.glb`, its partial import seed, `margo-import.gd`, a README and a manifest with the
exact payload SHA-256 hashes (using WebCrypto). An input Buffer is cloned before asynchronous work. It generates no
project file, cache, host path or import UID. `folder` accepts safe relative ASCII folder segments; use a
different directory for another asset. Replacing existing content and copying during an active editor import need
caller coordination.

The configured Godot 4.7.2 mechanism embeds PNGs uncompressed, without mipmaps, disables mesh compression/LODs/shadow
meshes and retains immutable animation tracks. Existing nearest texture samplers are preserved. The explicit helper
inventory must match every hidden, static `-convcol` mesh node by its unique exported `extras.id`; ordinary art, skins,
morphs, instances and animated helper ancestry are rejected as helper inputs. The script validates all imported
identities/shapes and requires identity shape-to-mesh alignment before replacing any shape with native
`ArrayMesh.create_convex_shape(false, false)`, preserving its margin. Failure frees the rejected scene. There is no
custom hull construction, geometry rewrite or automatic collision authoring.

Only STEP animation is accepted. A uniform positive clip `extras.fps` supplies the native clock; mixed or missing
metadata requires an explicit `fps`. Every actual Float32 key time must lie on a unique point of that grid or
the bundle rejects, so an explicit clock cannot silently discard a transition. The original clip names, loop
metadata, Godot loop-token names and bytes remain unchanged. For example, 12/24 FPS keys can fit a 24 FPS import
clock, while 12/30 can fit 60; this CPU preflight is not native certification of mixed clocks.

Animated bundles explicitly disable optimizer and compression on the generated `PATH:AnimationPlayer` node. Godot's
default optimizer can merge distinct tiny STEP keys, so immutable-track retention alone does not preserve every
authored hold. A source node named `AnimationPlayer` rejects this route because its collision can change the native
generated player path; rename it or use general GLB. The importer path is pinned to Godot 4.7.2 and needs native
acceptance in another version. There is no guessed global or per-clip optimizer setting.

The delivery preflight requires one embedded BIN buffer and bounds every declared buffer view and ordinary accessor
against it, including geometry, image, skin and animation references. Additional/external buffers, external images,
sparse accessors and unsupported matrix encodings reject without mutating caller bytes or emitting partial files.

This is a target import profile, separate from raw Godot defaults and generic/Roblox exports. Exact native RGBA,
normals, UVs, animation holds/loops, collision surfaces and physics require acceptance for the asset and destination
version. Fresh Godot 4.7.2 tests established the seed, embedded-image and static-helper mechanisms; relocation,
open-editor copy ordering and other versions remain separately tested behavior. CPU coverage is
`node --test packages/exporters/tests/godot.test.js packages/exporters/tests/subpaths.test.js`.

Godot's glTF import reads `COLOR_0` as sRGB, ignores it unless the material opts in, and has no clip loop flag.
`createGodotImportAddon()` (from `@margoengine/exporters/godot-addon`) returns an editor add-on (`addons/gltf_import/plugin.cfg`, `plugin.gd`, `extension.gd`)
that fixes both for any GLB: materials of primitives with `COLOR_0` use it as linear albedo (a material shared with
uncolored primitives is cloned once), and each clip's `extras.loop` boolean sets its loop. Write the entries into the
project, enable "glTF vertex colors and loops" under Project Settings > Plugins, then reimport.

A baked GLB (a lightmap on TEXCOORD_1, written as `lightmap`) needs its own material in Godot.
`createGodotLightmapImport({albedo, lightmap, emission?, lightmapScale, emissionScale})` (from
`@margoengine/exporters/godot-lightmap`) returns an unshaded shader
(`albedo * lightmap * lightmapScale + emission * emissionScale`) and an `EditorScenePostImport` script that applies it
to every MeshInstance3D; paths are relative to the GLB's folder. Select the script as the GLB's Import Script and
reimport.

## Skin authoring (`@margoengine/exporters/skin`)

An optional subpath (nothing else imports it) that skins a mesh to an authored rest skeleton:

| Function | Result |
| --- | --- |
| `checkJoints(joints)` | Throws unless 1 to 1024 joints `{name, parent, position}` form one tree with one root (`parent: -1`) |
| `skinWeights(positions, joints, {origin?, influences?})` | `{joints: Uint16Array, weights: Float32Array}`, four per vertex: the `influences` (default 4) nearest bone segments (parent to joint; the root's is its point), inverse-distance weights summing to 1, ties to the lower joint index. Points so far away that distances overflow are measured in a scaled space, so every finite point gets positive weights |
| `skinBindMatrices(joints, origin?)` | Column-major `local`, `world` and `inverseBind` rest matrices, 16 values per joint |
| `skinHierarchy(joints, {origin?, name?})` | Joint `ExportNode`s (`root`, `nodes`) and the `SkinData` for the mesh node, skeleton set |
| `humanoidJoints(min, max)` | An 18-joint upright humanoid rest skeleton fitted to a box (y up, facing +z, its left side at +x as in glTF), to refine by hand |

Coordinate conventions: joint positions are in joint space, the mesh's vertices in mesh space, and `origin` is the
joint-space point at the mesh's origin (joint = mesh + origin; a voxel model's pivot when joints are grid
coordinates). Matrices are column-major. Joints have no rest rotation: each local rest transform is the translation
from its parent (the root's from the mesh origin) and each inverse bind matrix the translation by minus the joint's
mesh-space position, so the rest pose leaves every vertex in place. Put `root` beside the mesh node, under the same
parent.

```ts
import {exportGLB} from 'margoengine/exporters';
import {humanoidJoints, skinHierarchy, skinWeights} from 'margoengine/exporters/skin';

// A 1 x 2 x 0.5 box figure, its origin at the bottom centre.
type Vec3 = [number, number, number];
const min: Vec3 = [-0.5, 0, -0.25], max: Vec3 = [0.5, 2, 0.25], pivot: Vec3 = [0, 0, 0];
const positions = new Float32Array([-0.5, 0, 0.25, 0.5, 0, 0.25, 0.5, 2, 0.25, -0.5, 2, 0.25]);
const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
const joints = humanoidJoints(min, max), origin = pivot;
const {root, skin} = skinHierarchy(joints, {origin, name: 'Rig'});
const mesh = {name: 'Figure', geometry: {positions, normals, indices, ...skinWeights(positions, joints, {origin})}, skin};
const glb = exportGLB({nodes: [{name: 'Model', children: [mesh, root]}]});
```

## Hashing exported files (`@margoengine/exporters/hash`)

An optional subpath for content hashes of exported files and manifests, with no other hash library:

| Function | Result |
| --- | --- |
| `sha256(bytes)` | 64 lowercase hex digits |
| `new SHA256().update(a).update(b)`, `.digest()` / `.hex()` | Incremental, synchronous SHA-256 (FIPS 180-4): hash a file in pieces as it is written; no input is copied or kept |

```ts
import {exportGLB} from 'margoengine/exporters';
import {SHA256, sha256} from 'margoengine/exporters/hash';

const glb = exportGLB({nodes: []});
const header = new TextEncoder().encode('{"format":"model"}'), body = glb;
const fileHash = sha256(glb);
const manifestHash = new SHA256().update(header).update(body).hex();
```

Measured in Node 26 on the development machine: 266 MB/s (64 MiB in 241 ms). For one-shot hashing of large buffers in
a browser, `crypto.subtle.digest('SHA-256', bytes)` is faster. To check exported textures, read them with
`decodePNG` from `@margoengine/decoders/png`.

## GLB size limits

`exportGLB(source, {maxBinaryBytes, maxBytes})` bounds the output:

| Option | Counts | Matches |
| --- | --- | --- |
| `maxBinaryBytes` | The BIN chunk payload: every buffer view (vertex attributes, indices, inverse bind matrices, animation keys, embedded images) with the zero padding that starts each on a 4-byte boundary | The BIN chunk header's length |
| `maxBytes` | The whole file: the 12-byte header, the JSON chunk (8-byte header, JSON as UTF-8, space padding) and the BIN chunk (8-byte header, payload) | The GLB header's length (`glb.length`) |

Both take a whole number of bytes from 0 to 4,294,967,295 (the GLB format's own limit, also the default); another
number throws a RangeError, a non-number a TypeError. An export over a limit throws a RangeError naming the limit and
the bytes needed. A limit equal to the exact output size passes; one byte less refuses. With neither option the output
is unchanged, except that a GLB the format cannot describe (over 4 GiB) now throws instead of being written with a
wrapped length.

The checks run before the work they protect, with sizes kept as safe integers:

- each new geometry's vertex attributes, each index list that will be written (16- or 32-bit as the vertex count
  decides) and each new image are counted when the scene is collected, before the geometry is normalized (copied) or
  anything is written;
- every buffer view (and each 16-bit index copy) is checked against both limits before it is placed;
- the JSON's UTF-8 size is computed from the serialized text, and the whole file checked, before the JSON is encoded
  and the GLB is allocated.

So an over-limit export does not allocate the GLB or the BIN payload, and vertex-, index-, image- and JSON-heavy
exports are refused before any buffer near the limit's size is allocated (the tests wrap the typed-array
constructors and `TextEncoder.encode` to check this). One copy is not counted first: a geometry used only through
primitives that bring their own `indices` still has its own index list copied when it is normalized. Measured on a 4.5 million vertex scene with a
32 MiB image (a 177,555,716-byte GLB, 213 ms to export in full): a 128 MiB `maxBinaryBytes` or `maxBytes` refuses it
in 0.2 to 1.0 ms.

These are output limits, not a bound on peak memory. While exporting, the writer also holds: the caller's inputs
(images are embedded as given, by reference, and copied once into the GLB; caller arrays are never changed);
normalized Float32 copies of each geometry's vertex data and indices, and Float32 copies of animation keys and inverse
bind matrices; copies of extras; the JSON text, which is built before its size is known; and finally the GLB itself.
PNG encoding is not part of `exportGLB`: textures arrive as encoded bytes (`paletteTexture` and `encodePNG` run
before it, outside these limits). `exportGLTF` and `exportModel` take no limits.

## Compressed GLB files

Each of these takes GLB bytes and returns smaller GLB bytes, so it follows any writer here and any GLB from elsewhere. Materials, images, skins, animations, extensions and extras stay as they were, apart from the duplicates `optimizeGLB` merges.

### Draco (`@margoengine/exporters/draco`)

`compressDraco(glb, options)` stores triangle geometry as KHR_draco_mesh_compression, with Google's own Draco encoder in Wasm. The encoder loads on the first call: in a worker in a browser, in process in Node. An app that never compresses never fetches it.

```ts
import { exportGLB } from 'margoengine/exporters';
import { compressDraco } from 'margoengine/exporters/draco';

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
const source = exportGLB({ nodes: [{ geometry: { positions, normals, indices: [0, 1, 2, 0, 2, 3] } }] });

const { glb, compressed, skipped } = await compressDraco(source, { positionBits: 14 });
console.log(`${source.length} -> ${glb.length} bytes, ${compressed} primitives, ${skipped.length} left as they were`);
```

| Option | Default | What it does |
| --- | --- | --- |
| `positionBits` | 14 | POSITION. The primitives of a mesh share one grid, so a seam between them stays closed |
| `normalBits` | 10 | NORMAL, on Draco's octahedron |
| `texcoordBits` | 12 | Float TEXCOORD_n |
| `colorBits` | 8 | Float COLOR_n |
| `tangentBits` | 12 | TANGENT |
| `weightBits` | 0 | Float WEIGHTS_n. Exact by default: quantized weights no longer add up to 1 |
| `encodeSpeed`, `decodeSpeed` | 5 | From 0, the smallest file, to 10, the fastest |
| `encoderPath` | the bundled copy | URL of a folder with `draco_encoder_wrapper.js` and `draco_encoder.wasm` |
| `signal` | none | Stops the encode: at once in a browser, between meshes in Node |

Bits of 0 keep a float attribute exact. Integer attributes such as JOINTS_n and `_CUSTOM` attributes are always exact. Draco is lossy above that: a position lands on a grid of `2 ** positionBits - 1` steps across the mesh's widest axis, so at most half a step from where it was. Accessor `count`, `min` and `max` describe what a decoder gets, to the last bit.

Draco has no place for morph targets and can reorder vertices, so a primitive with targets stays uncompressed, and so do points, lines, strips and fans. `skipped` names each one with its reason. Primitives that differ only in material share one stream. `compressDraco` refuses a GLB with meshopt buffers, and a file with nothing to compress comes back as the same bytes.

### KTX2 textures (`@margoengine/exporters/ktx2`)

`compressTextures(glb, options)` stores the textures of a GLB as KTX2 with Basis Universal (`KHR_texture_basisu`), so they stay compressed on the GPU as well as on the wire. `encodeKTX2(image, options)` writes one `.ktx2` file from a PNG, a JPEG or RGBA8 pixels. The encoder is Binomial's own, in Wasm, and loads on the first call: in a worker in a browser, in process in Node. Image files are read there too, so a page never decodes a large image on its own frame, and neither needs a browser.

```ts
import { exportGLB } from 'margoengine/exporters';
import { encodePNG } from 'margoengine/exporters/capture';
import { compressTextures, encodeKTX2 } from 'margoengine/exporters/ktx2';

const data = new Uint8Array(64 * 64 * 4).fill(200);
const image = await encodePNG({ width: 64, height: 64, data });
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]);
const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
const uvs = new Float32Array([0, 0, 1, 0, 1, 1]);
const source = exportGLB({
  nodes: [{
    geometry: { positions, normals, uvs, indices: [0, 1, 2] },
    material: { baseColorTexture: { image, mimeType: 'image/png' } },
  }],
});

const { glb, compressed, skipped } = await compressTextures(source);
console.log(`${source.length} -> ${glb.length} bytes, ${compressed} textures, ${skipped.length} left as they were`);

const file = await encodeKTX2({ width: 64, height: 64, data }, { mode: 'uastc', colorSpace: 'linear' });
console.log(`${file.length} bytes of .ktx2`);
```

`compressTextures` options:

| Option | Default | What it does |
| --- | --- | --- |
| `color` | `'etc1s'` | Format of colour textures: base colour, emissive, specular colour, sheen colour |
| `normal` | `'uastc'` | Format of normal maps |
| `data` | `'uastc'` | Format of the rest: metallic-roughness, occlusion and the like |
| `quality` | 128 | ETC1S quality, from 1 to 255 |
| `effort` | 2 | ETC1S encoder effort, from 0 to 6 |
| `uastcLevel` | 2 | UASTC encoder level, from 0, the fastest, to 4, the closest to the source |
| `uastcRDO` | 0 | UASTC rate-distortion pass, from 0, off, to 10: smaller on the wire, further from the source, slower |
| `encoderPath` | the bundled copy | URL of a folder with `basis_encoder.js` and `basis_encoder.wasm` |
| `signal` | none | Stops the encode: at once in a browser, between images in Node |

`encodeKTX2` takes the last six, plus `mode` (`'etc1s'`, the default, or `'uastc'`), `colorSpace` (`'srgb'`, the default, or `'linear'`), `normalMap` (false) and `mipmaps` (true).

ETC1S is the smallest and the most lossy; UASTC keeps more detail in more bytes. On the GPU a texture takes a byte a pixel from UASTC and half that from opaque ETC1S, where a PNG or JPEG takes four. On the wire the result depends on the source: PNG models here came to as little as 57% of their size, while a model of heavily compressed JPEGs can double. `data: 'etc1s'` and `uastcRDO` trade quality for bytes; `uastcRDO: 1` took Lantern from 57% to 46%, in over twice the time. A material decides each texture's role, so colour is marked sRGB and everything else linear; a texture read in two roles is split in two. Each texture gets a full mip chain and grows to the next multiples of 4, which the extension requires. The PNG and JPEG images leave the file and `KHR_texture_basisu` becomes required, so a reader without it cannot show them.

`skipped` names each texture left as it was: one no material reads, one already in KTX2, one held by WebP, AVIF or DDS, an image in an outside file, an image that is neither PNG nor JPEG. A file with nothing to compress comes back as the same bytes. Images keep their stored samples: EXIF orientation and colour profiles are ignored, as glTF says, and 16-bit PNG samples keep their high byte.

### Meshopt (`@margoengine/exporters/meshopt`)

`compressMeshopt(glb, options)` stores geometry, skins and animation as `EXT_meshopt_compression`, and by default stores vertices as small integers with `KHR_mesh_quantization`. The codecs are plain code written from the extension's text, so there is no Wasm to load and no worker, and the work runs on the calling thread with a pause between primitives. A reader needs both extensions; `@margoengine/gltf-pro` and `@margoengine/gltf/meshopt` read the file with the decoder in `@margoengine/decoders`.

```ts
import { exportGLB } from 'margoengine/exporters';
import { compressMeshopt } from 'margoengine/exporters/meshopt';

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
const source = exportGLB({ nodes: [{ geometry: { positions, normals, indices: [0, 1, 2, 0, 2, 3] } }] });

const { glb, compressed, quantized, skipped } = await compressMeshopt(source);
console.log(`${source.length} -> ${glb.length} bytes, ${compressed} streams, ${quantized} attributes as integers`);
```

| Option | Default | What it does |
| --- | --- | --- |
| `quantize` | true | Positions in 16 bits on one grid for the whole mesh, normals and tangents in `normalBits`, texture coordinates in 16, colours and skin weights in 8. `false` keeps every value exact |
| `normalBits` | 8 | NORMAL and TANGENT: 8 or 16 |
| `signal` | none | Stops between primitives |

A position lands within half a step of a grid of 65,534 steps across the mesh's widest axis, and the grid goes into the node's transform, so the file stays where it was. A node that something else depends on (an animation target, a joint, a parent, a camera) keeps its transform, and a new child node holds the mesh and the grid. Skinned meshes, instanced meshes and meshes with morph targets keep float positions: a skin ignores its node's transform, and morph targets add to positions as stored. Texture coordinates outside 0 to 1 stay floats. Skin weights still add up to 1 after rounding.

Triangles that repeat a vertex and vertices no triangle uses go, and each primitive's vertices are renumbered, which the triangle codec requires. Primitives that keep Draco are listed in `skipped`. A very small file can grow, because each stream adds JSON and a fixed tail: compare the lengths when that matters. `encodeVertexBuffer` and `encodeTriangles` are the two codecs on their own.

### Optimize (`@margoengine/exporters/optimize`)

`optimizeGLB(glb, options)` is the clean-up a file needs before it ships, so no separate tool chain is needed: duplicate data merges, identical vertices weld, and meshes simplify or gain `MSFT_lod` levels. By default it does only the first two, which change nothing a viewer shows. Run it before `compressDraco` or `compressMeshopt`. `compressTextures` can run on either side of it.

```ts
import { exportGLB } from 'margoengine/exporters';
import { optimizeGLB } from 'margoengine/exporters/optimize';

const positions = [];
const normals = [];
const indices = [];
// A bumpy sheet with four vertices of its own in each cell.
for (let y = 0; y < 16; y++)
  for (let x = 0; x < 16; x++) {
    const at = positions.length / 3;
    for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      positions.push(x + dx, y + dy, Math.sin((x + dx) * 0.7) * Math.cos((y + dy) * 0.5));
      normals.push(0, 0, 1);
    }
    indices.push(at, at + 1, at + 2, at, at + 2, at + 3);
  }
const source = exportGLB({
  nodes: [{ geometry: { positions: new Float32Array(positions), normals: new Float32Array(normals), indices } }],
});

const { glb, stats, skipped } = await optimizeGLB(source, { lods: [0.5, 0.25] });
console.log(`${stats.verticesBefore} -> ${stats.verticesAfter} vertices, ${stats.levels} level nodes, ${skipped.length} left as they were`);
```

| Option | Default | What it does |
| --- | --- | --- |
| `dedupe` | true | Merges images with the same bytes, then the samplers, textures, materials, accessors and meshes that makes equal |
| `weld` | true | Merges vertices equal in every attribute and morph target, drops triangles with no area and vertices no triangle uses. Off, only unused vertices go |
| `simplify` | none | Fraction of each primitive's triangles to keep, above 0 and below 1 |
| `lods` | `[]` | Fractions of the triangles each further level keeps, decreasing, written as `MSFT_lod`. With `simplify`, fractions of what that leaves |
| `screenCoverage` | none | `MSFT_screencoverage`, decreasing, at most one more than `lods`. Without it the reader picks its own switches |
| `signal` | none | Stops between primitives |

Every level is a subset of the vertices it came from, so UVs, skin weights and morph targets stay the source's own and seams and hard edges stay closed. Vertices at one position that move differently, such as closed lips, stay two vertices. A flat-shaded mesh is the one case with new values: a triangle a level keeps takes its own normal. A collapse removes one or two triangles, so a level lands within two of its fraction, and a part too small to reach it keeps its last triangles.

Level nodes sit outside the scene, copy their node's transform and skin, and follow its animation, so a reader without `MSFT_lod` draws the finest level and nothing else changes. A node with an extension of its own, such as `EXT_mesh_gpu_instancing`, gets no levels, and a file that already has `MSFT_lod` refuses `lods`. Materials with different names stay apart, because code finds them by name. When `KHR_animation_pointer`, `KHR_interactivity` or `MSFT_lod` is in the file, textures, materials and meshes keep their indices, and `EXT_lights_image_based` keeps images in place, because those name them by number.

`skipped` lists the primitives left as they were: Draco ones, ones with no position, points, lines, strips and fans, and, with `reason: 'too-large'`, a primitive past the simplifier's 200,000 vertices or faces, which is welded but not simplified. Meshopt buffers are refused: optimize first, then compress. `weldVertices(arrays, indices, vertexCount)` is the weld on its own, and `margo-convert` uses it.

## Limits

The engine/data-scene `exportGLTF` and `exportGLB` entrypoints write cameras, lights, extras and
`KHR_materials_unlit`, `KHR_materials_transmission`, `KHR_materials_ior`, `KHR_materials_emissive_strength`, and
base-color `KHR_texture_transform` with its `KHR_animation_pointer` clips only from data-scene nodes and materials, and no
instancing or other KHR material extensions; use `exportModel` for loaded glTF-pro camera/light attachments and PBR
metadata. The writers do not produce sparse accessors or interleaved buffers; [compressed GLB files](#compressed-glb-files) come from the passes above. Engine/data-scene skins support four influences per vertex. `exportGLTF` puts images
in the buffer rather than separate image files. PLY writes every vertex as given; OBJ welds only whole
corners (`mergeVertices`), never `v`, `vt` and `vn` separately. Node names are not made unique. The existing `@margoengine/gltf` loader accepts what these exporters write from
an engine, but data-scene exports with deformation, vertex colors or textures need the optional packages described above.

## Tests

`node --test packages/exporters/tests/scene-camera-lights*.test.js` from the repository root tests actual loaded
DirectionalLight, Cameras, PointLightIntensityTest and Box assets in GLB and JSON. It compares exported definitions,
node references and reloaded transforms; checks live edits, hidden nodes, multiple models and camera/light-free
scenes; and rejects invalid live metadata. With the official validator installed, every round trip requires zero
validator errors. GPU operations and PNG decoding use Node boundary shims; the loader and PBR model setup run unchanged.

`npm test` in `packages/exporters` runs Node checks against a real Margo Engine `Engine` and Wasm transform kernel with a no-op renderer: every glTF and GLB is run through the official Khronos `gltf-validator` and must have zero errors and zero warnings; GLBs are re-imported with `@margoengine/gltf` and the kernel's world matrices, vertex data and materials are compared; deduplication, min/max and 4-byte alignment are checked; the Khronos Box and BoxTextured assets are round-tripped (BoxTextured with its PNG, UVs, tangents and colors); STL binary is checked byte by byte (80-byte header, count, 50-byte records) and ASCII STL, OBJ/MTL and both PLY encodings are parsed back by small reference parsers. The validator comes from the repository root's `gltf-validator` dev dependency; set `MARGOENGINE_EXPORTERS_TOOLS` to use a copy installed elsewhere. Without it the validator tests are skipped.

`npm run test:browser` builds a parented hierarchy with shared geometry, two materials and a hidden mesh in a real WebGPU engine (Playwright, honoring `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE` and `BROWSER_ARGS`), exports it, re-imports the GLB into the same engine and compares canvas pixels, world matrices and vertex data, checks for zero WebGPU validation errors, and validates the browser-made GLB, glTF and flattened GLB with the Khronos validator.

Apache-2.0 licensed.

## USDZ for AR Quick Look

`exportUSDZ(engineOrDataScene, options)` returns a `Uint8Array`: a static USDA root and its texture images in an uncompressed ZIP with 64-byte-aligned entries. Positions, normals and reflected winding use the existing validated scene collector. Names are kept as display names; hidden descendants are skipped. The stage has a default prim, Y up, meter units, mesh extents and UsdPreviewSurface color/roughness/metalness/emission/opacity materials.

Import `exportUSDZ` from `@margoengine/exporters/usdz`; it loads only USDZ serialization and its shared scene collector. The package root does not export it, so applications that never write USDZ do not carry it.

Save as `.usdz`. A supported Apple device can open `<a rel="ar" href="model.usdz"><img src="preview.png" alt="View the model in AR"></a>`. No headset is required to generate or validate the file.

AR Quick Look shows a file at real size, and glTF numbers are metres, so a model authored in other units stands as tall as its numbers say: Fox.glb is 79 metres. `measureUSDZ(source, options)` returns `{ size, bounds, scale }` in metres before you send a file anywhere, `height` sets the rest pose's height in metres and `ground` stands its lowest point on the floor. Both go in one transform on the root prim, so proportions, meshes and animation data stay as they are. With neither, the file holds the model's true size and no root transform.

```ts
import { exportUSDZ, measureUSDZ } from 'margoengine/exporters/usdz';

const scene = {
  nodes: [
    {
      name: 'Marker',
      geometry: {
        positions: new Float32Array([0, -40, 0, 30, -40, 0, 30, 40, 0, 0, 40, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: [0, 1, 2, 0, 2, 3],
      },
    },
  ],
};

const [, height] = measureUSDZ(scene).size; // 80: this model would stand 80 metres tall.
const usdz = exportUSDZ(scene, { height: 1.2, ground: true });
console.log(`${height} m as authored, ${usdz.length} bytes at 1.2 m`);
```

| Option | Default | What it does |
| --- | --- | --- |
| `height` | the source's own size | The rest pose's height in metres. The whole model scales evenly from the origin |
| `ground` | `false` | Moves the model so the rest pose's lowest point is at y = 0 |

Every mesh is written in its own space, with the node's world matrix as `xformOp:transform`, so its points are the ones you gave. A geometry object two or more nodes draw is written once as a class prim, and each node references it with its own transform, name and material, so a thousand copies of a box cost a thousand short nodes. A node with a reflection in its matrix draws a reflected copy of the geometry, written once for all the nodes that mirror it, with the reflection taken out of the node's matrix and the winding reversed in the file: no matrix in the file has a negative determinant, so nothing depends on how a viewer treats a negative scale. Parents are folded into each node's matrix; the file holds no Xform tree.

```ts
import { exportUSDZ } from 'margoengine/exporters/usdz';

const box = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
// One mesh in the file: pass the same object to share it, a copy to keep a mesh of its own.
const usdz = exportUSDZ({
  nodes: [
    { name: 'left', translation: [-1, 0, 0], geometry: box },
    { name: 'right', translation: [1, 0, 0], geometry: box },
  ],
});
```

Vertex colors (RGB or RGBA, baked AO included) multiply the base color and are written as vertex `displayColor` (and, for BLEND and MASK materials, `displayOpacity`) primvars that the surface reads through `UsdPrimvarReader` shaders. Quick Look does not follow those readers and draws such a mesh grey ([known bug](../../docs/known-bugs.md#usdz-vertex-colours-draw-grey-in-quick-look)). Animation, skins and morphs are not exported.

Material textures are the same `TextureData` (encoded PNG or JPEG bytes) the glTF writers take, from a data scene or from `materialData` for engine meshes. Each becomes a `UsdUVTexture` reading the mesh's `primvars:st` (its `uvs`, V flipped to USD's bottom-left origin) or `primvars:st1` (`uvs1`, for `texCoord: 1`) through a `UsdPrimvarReader_float2`, with its `wrapS`/`wrapT`:

- `baseColorTexture` drives `diffuseColor` (`inputs:scale` is the color factor, sRGB) and, for BLEND and MASK, `opacity` from its alpha; MASK writes `opacityThreshold = alphaCutoff` (default 0.5). A `baseColorTextureTransform` becomes a `UsdTransform2d` that samples the same texels: `rotation` (radians; positive turns the picture clockwise on the surface, as gltf-pro draws KHR_texture_transform) is written in degrees with the same sign, because the V flip also flips the rotation sense, and the translation is re-expressed in st.
- `metallicRoughnessTexture` drives `roughness` from green and `metallic` from blue, scaled by the factors.
- `normalTexture` (scale 2, bias -1, with `normalScale` on x and y), `occlusionTexture` red (`occlusionStrength`) and `emissiveTexture` (times `emissive` and `emissiveStrength`) are read as raw, raw and sRGB.

The image bytes are stored unchanged under `texturePrefix` (default `textures/`), each once, with every file's data 64-byte aligned. Vertex colors cannot be combined with a base color texture (UsdPreviewSurface has no multiply), a texture whose UV set is missing is refused, and sampler filters and mipmaps have no USD equivalent and are dropped.

```ts
import { exportUSDZ } from 'margoengine/exporters/usdz';
import type { TextureData } from 'margoengine/exporters';

declare const albedoPNG: Uint8Array;
const albedo: TextureData = { image: albedoPNG, mimeType: 'image/png', name: 'albedo' };
const usdz = exportUSDZ({
  nodes: [
    {
      geometry: {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        uvs: [0, 1, 1, 1, 1, 0, 0, 0],
        indices: [0, 1, 2, 0, 2, 3],
      },
      material: {
        baseColorTexture: albedo,
        // Two tiles each way, turned 30 degrees clockwise on the surface.
        baseColorTextureTransform: { offset: [0, 0], scale: [2, 2], rotation: Math.PI / 6 },
        alphaMode: 'MASK',
        alphaCutoff: 0.5,
      },
    },
  ],
});
// usdz holds scene.usda and textures/albedo.png.
``` Quick Look on a Mac draws the textured kit as intended, apart from `normalScale`, which it ignores; no iPhone or iPad has opened it yet. `node scripts/make-usdz-quicklook-kit.mjs <folder> --glb` (repository root, after `npm run build:packages`) writes the eight small textured test scenes for that check (alpha mask, alpha blend, metal-rough with a normal map at scale 1 and 2, occlusion with emissive, texture transform with rotation and repeat and mirror wrapping, and rotation +30 and -30 degrees alone) as `.usdz` files, with `.glb` twins the engine can draw as references; `tests/usdz-quicklook-kit.test.js` checks their layout. `node --test tests/usdz.test.js` checks ZIP layout, the texture shader graph and round trips through `@margoengine/loaders` and `@margoengine/usdz`. Install the official `usd-core` wheel and run `python tests/validate-usdz.py model.usdz` for independent metadata, topology, vertex-color wiring and available OpenUSD package/material validators.

### Animated USDZ (`@margoengine/exporters/usdz-anim`)

`exportAnimatedUSDZ(source, options)` writes one clip of a data scene or of GLB bytes as USDZ, so a character plays in AR Quick Look. Skins become UsdSkel: a `SkelRoot` holding a `Skeleton`, its `SkelAnimation` and the meshes it moves, with `primvars:skel:jointIndices` and `primvars:skel:jointWeights` on each mesh. Any other node a clip moves, or a mesh on a joint, becomes an `Xform` with time samples, in the file's own tree. Materials and shared meshes are the ones `exportUSDZ` writes.

```ts
import { exportAnimatedUSDZ } from 'margoengine/exporters/usdz-anim';

const box = {
  name: 'Box',
  geometry: {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: [0, 1, 2, 0, 2, 3],
  },
};

const { usdz, clip, frames, size, bounds, skipped } = await exportAnimatedUSDZ(
  {
    nodes: [box],
    animations: [{ name: 'Slide', channels: [{ node: box, path: 'translation', times: [0, 2], values: [0, 0, 0, 3, 0, 0] }] }],
  },
  { height: 0.5, ground: true },
);
console.log(`${clip}: ${usdz.length} bytes, ${frames} frames, ${skipped.length} left out`);
console.log(`${size[1]} m tall, reaching x = ${bounds.max[0]} m`);
```

| Option | Default | What it does |
| --- | --- | --- |
| `clip` | 0 | Which animation, by index or name. USD has one timeline, so a file holds one clip: write one file for each |
| `fps` | 30 | Samples per second, and the file's `timeCodesPerSecond` |
| `signal` | none | Stops between frames and nodes |
| `height` | the source's own size | The rest pose's height in metres, as `exportUSDZ` |
| `ground` | `false` | Stands the rest pose's lowest point on the floor, as `exportUSDZ` |
| `texturePrefix` and the collector's options | as `exportUSDZ` | Where images go in the archive, and what the scene collects |

The result says what a phone will show: `size` is the rest pose's width, height and depth in metres, `bounds` is everywhere the clip reaches, skinned, at every frame, and `scale` is what `height` asked for. Read them before you send a file: Fox.glb's `size` is about 25 by 79 by 155 until you pass `height`, and a clip can reach well past the rest pose, as robot-expressive's Jump does at 1.3 times its height. A model that fits a room at a couple of metres is under about 1.5 metres across and 2 metres tall in `bounds`.

A skin's points are written where the mesh rests in the world, with that move taken back out of `bindTransforms`, as a glTF skin's vertices can sit in any space. So a model stored lying down or in millimetres reads the right size in a tool that does not run the skeleton, and it plays exactly as before. Each `SkelRoot` has an `extent` for every frame.

A GLB goes in as it is, with its nodes, skins, clips and PBR materials. Decode Draco and meshopt first: run this before `compressDraco` or `compressMeshopt`, or on the uncompressed file. A file with a second set of joints is refused; bake it down to four influences.

Tracks are sampled at `fps`, as USD stores them, and the viewer blends between frames: a STEP key turns over one frame instead of at once, and a clip that ends between two frames holds its last pose on the frame after, so it runs up to one frame longer. `SkelAnimation` keeps scales as half floats, 11 bits, so a joint's scale rounds to about 0.05%.

`skipped` lists what the file does not carry: `'morph-weights'` channels, as the mesh stays in its base shape, `'not-exported'` channels of a node the scene left out, and for GLB input `'primitive'` not triangles, `'texture'` not PNG or JPEG, `'colors'` under a base colour texture and `'channel'` with no node, such as one of `KHR_animation_pointer`.

A joint under nodes that are not joints takes their motion, and a joint scaled to zero, as a clip that makes a character appear does, keeps its rotation. What cannot be held is refused: a shear in the nodes above a joint, since a joint is a translation, rotation and scale. A mirrored node draws a reflected shape as in `exportUSDZ`, chosen at frame 0, so a clip that turns a scale negative part way keeps the winding it started with.

## 3MF for 3D printing (`@margoengine/exporters/threemf`)

`export3MF(source, options)` writes a scene or GLB bytes as a 3MF file, which slicers prefer over STL because it holds its unit and its colours.

```ts
import { export3MF } from 'margoengine/exporters/threemf';

// A tetrahedron 40 mm across, closed, so it prints.
const geometry = {
  positions: new Float32Array([0, 0, 0, 0.04, 0, 0, 0, 0.04, 0, 0, 0, 0.04]),
  normals: new Float32Array(12),
  indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
};

const file = await export3MF(
  { nodes: [{ name: 'Peg', geometry, material: { color: [1, 0.2, 0, 1] } }] },
  { unit: 'millimeter', upAxis: 'z', title: 'Peg' },
);
console.log(`${file.length} bytes`);
```

| Option | Default | What it does |
| --- | --- | --- |
| `unit` | `'millimeter'` | `micron`, `millimeter`, `centimeter`, `inch`, `foot` or `meter`. Scene lengths are metres, as in glTF, and are converted, so a 1 m cube is 1000 long in `'millimeter'` |
| `upAxis` | `'y'` | The scene's up axis. A printer's Z is up, so `'y'` turns the scene to stand on the bed; `'z'` leaves it as it is |
| `title` | none | The file's Title metadata, and the assembly's name |
| `assembly` | `true` | Writes a scene of several nodes as one object, every part in place. `false` writes a build item for each node |
| `signal` | none | Stops the archive step |
| The collector's options | as `exportGLB` | What the scene collects |

A scene of several nodes is one object whose mesh holds every part where the scene put it, each part a shell of its own, so a slicer keeps the parts together and prints their union. Slicers read each build item as an object to move and scale on its own, components included, and PrusaSlicer 2.9.7 crashes on overlapping ones; a model is one thing to them. A part drawn fifty times is stored fifty times this way. With `assembly: false` each geometry and material pair is one object and each node a build item that places it, so a part is stored once, for a plate of separate prints that do not overlap. Vertices are welded by position within a part, in the file's unit and at Float32, because a slicer needs triangles that share their edges; a triangle that leaves with no area goes. A reflection is written into the triangles, so no item carries one and nothing turns inside out.

Base colours become `basematerials` and vertex colours a `colorgroup`, corner by corner, both in sRGB with alpha when it is not 1. Textures are not written; the material's base colour stands for them. Welding closes seams but does not repair a mesh: an open one is written as it is, and a slicer will say so. A model with parts floating over the bed needs supports on, as on any slicer: with nothing on the first layer PrusaSlicer stops at "no extrusions in the first layer".

## Collision and UV animation per engine

Name nodes with the `-col`, `-convcol`, `-colonly` and `-convcolonly` suffixes and author `materialAnimations` once; each
engine gets them its own way.

| Engine | Collision | UV animation (STEP base-color cels) |
| --- | --- | --- |
| Godot | Suffixes read directly at import (`godot`) | `createGodotFlipbookPlayer` (`godot-flipbook`) |
| Unity | Colliders from the suffixes (`unity`) | `createUnityUVClips` (`unity-uv`): constant keys on `material.baseColorTexture_ST` |
| Unreal | `unrealCollisionNames` (`unreal-import`): `UCX_`, `UBX_`, `USP_`; `-col` meshes use complex-as-simple | `createUnrealImportScript`: a Material that steps a cel grid at one rate |
| Roblox | `createRobloxCollisionScript` (`roblox-uv`): `-colonly` parts turn invisible with CanCollide | `createRobloxUVSwap`: one PNG per cel and a Luau `TextureID` swap with an id map you fill |

```ts
import {createRobloxCollisionScript, createRobloxUVSwap} from 'margoengine/exporters/roblox-uv';
import {createUnityUVClips} from 'margoengine/exporters/unity-uv';
import {createUnrealImportScript, unrealCollisionNames} from 'margoengine/exporters/unreal-import';
import type {ExportScene} from 'margoengine/exporters';

const material = {name: 'water'};
const geometry = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
};
const scene: ExportScene = {
  nodes: [{name: 'pool', geometry, material}, {name: 'wall-convcolonly', geometry, material}],
  materialAnimations: [{name: 'flow', channels: [
    {material, texture: 'baseColorTexture', property: 'scale', interpolation: 'STEP', times: [0], values: [0.5, 1]},
    {material, texture: 'baseColorTexture', property: 'offset', interpolation: 'STEP', times: [0, 0.5], values: [0, 0, 0.5, 0]},
  ]}],
};

const names = unrealCollisionNames(scene); // wall-convcolonly becomes UCX_wall_00: rename the node before exporting
const python = createUnrealImportScript(scene, {contentPath: '/Game/Hero'});
const unity = createUnityUVClips(scene, {folder: 'Hero'});
const luau = createRobloxCollisionScript(scene);
const roblox = await createRobloxUVSwap(scene, {
  texture: () => ({data: new Uint8Array(16), width: 2, height: 2}),
});
console.log(names, python.length, unity.length, luau.length, roblox.length);
```

- **Refused, with the fix named:** a channel that is not STEP (bake it to cels), a material no node draws, and in Unreal cels
  of unequal times or sizes or off a regular grid. Unreal also refuses a concave `-colonly`: split it into `-convcolonly` pieces.
- `exportRobloxGLB` still refuses `materialAnimations`: leave them out of its scene, then run `createRobloxUVSwap` on the full one.
- All three are checked by hand in the engine, not in CI.

## Roblox GLB (`@margoengine/exporters/roblox`)

Roblox Studio refuses a MeshPart over 20,000 triangles. `exportRobloxGLB` writes the ordinary GLB with every mesh
primitive split into parts of at most `maxTrianglesPerPart` (default 20,000) triangles; each part keeps its triangles
and exact vertex values and copies only the vertices it uses. Parts of shared geometry are written once.

```ts
import {Engine, box, PbrMaterial} from 'margoengine/core';
import {exportRobloxGLB} from 'margoengine/exporters/roblox';

// Downloads a file in the browser.
const save = (name: string, data: Uint8Array | string) => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([typeof data === 'string' ? data : data.slice()]));
  link.download = name;
  link.click();
};
const engine = await Engine.create(document.querySelector<HTMLCanvasElement>('canvas')!);
engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color: '#84d6bd'}));
const {glb, mapping} = exportRobloxGLB(engine, {animations: true});
save('model.glb', glb);
save('model.roblox.json', JSON.stringify(mapping));
```

`mapping.parts` lists each part's first source triangle, triangle count and source vertex indices; `mapping.uses`
places every part at a glTF node and primitive; `mapping.importSettings` gives the 3D Importer settings that keep the
parts apart (merge meshes off, imported pivots, vertex colors on, `collision: 'none'` or `'studio'`). Node
translation, rotation and scale clips are kept with `animations: true`. Features a MeshPart cannot hold throw with the
fix: skins without `skins: true`, morph targets, cameras, lights, `uvs1`, lightmaps, material clips, layered-clothing cage names and
collision or cage roles. `skins: true` keeps skins (their parts carry `JOINTS_0`/`WEIGHTS_0`) and checks Roblox's
custom-rig rules: every root joint rests at the origin and no vertex is weighted to a root joint. For data scenes,
`units: 'meters'` wraps the roots in one root scaled 25/7 studs per meter and `front: '+z'` turns that root 180 degrees
about Y (named `rootName`, default `Roblox_Studs`, with `rootExtras`); skinned mesh nodes stay roots, posed through
their joints. `materialPolicy: 'strict'` (default) also refuses material fields beyond base color,
roughness, metalness and emissive color; `'preserve'` writes them. Studio import is not tested here.

The same entry splits an application's own flat surfaces: `splitRobloxPrimitives(inputs, budget, strategy)` cuts each
surface (streams plus one source identity per triangle) into parts per `robloxChunkTriangleCounts` (`'fixed'` fills
parts to the budget, `'balanced'` evens them out), copying only used vertices in first-use order. `exportRobloxGLB`
uses the same fixed rule.

`@margoengine/exporters/roblox-chunks` checks a GLB written from those parts: `robloxPreflight` (layout, static,
qualified capability profile, appearance signatures, texture limits and 64-deep emitted hierarchy, with the
application's own material plans as hooks), `robloxChunkPreflight` (open, closed or zero-volume geometry per part) and
`verifyRobloxChunkGLB`, an independent reader of every node, material, texel and triangle corner against the
captured scene.

`@margoengine/exporters/roblox-runtime` writes a source bundle instead of a GLB: every surface in balanced parts of at
most 19,998 triangles, Float32 vertices in studs about each part's centre, the original RGBA8 images, a canonical
manifest, and a source Folder (place `.rbxlx` and model `.rbxmx`) whose `Restore` ModuleScript
(`@margoengine/exporters/roblox-runtime-restore`) rebuilds the geometry live with EditableMesh and EditableImage.
`robloxRuntimePreflight` is its policy and `verifyRobloxRuntimeBundle` re-reads the whole package. Restore runs in
Studio; it is not run here.

## Precision bundles for Unity, Unreal and Godot

A precision bundle carries a static scene to an engine with every source value it can store: the application's
complete source master, a hash-bound canonical manifest, the original atlas pixels and a native helper that imports
the geometry, binds the atlas with nearest/clamp sampling and checks every triangle corner, node and texel after
save and reopen. Each entry has a preflight (`unityPrecisionPreflight`, `unrealPrecisionPreflight`,
`godotPrecisionPreflight`), an assembler (`create...PrecisionBundle`) and an independent verifier
(`verify...PrecisionBundle`):

| Entry | Geometry | Native helper |
| --- | --- | --- |
| `unity-precision` | the application's exact static GLB | C# for the unmodified glTFast importer (`unity-precision-importer`) |
| `unreal-precision` | the application's exact static GLB | Python for Interchange (`unreal-precision-importer`) |
| `godot-precision` | raw Float32 streams per surface, normals in CUSTOM0 | an EditorImportPlugin addon (`godot-precision-addon`) |

The scene is a structural `PrecisionScene` (objects, faces with object-space, world and output corners, effective UVs
and corner colours, materials and images), so an application passes its own export snapshot without copying it.
What only the application knows stays its own: `PrecisionSourceChecks` hooks judge its record schema and material
metadata, it supplies the master bytes and its scene hash, and for Unreal the Python that reads its master format.
`appName` names the helper, folders, metadata keys and log lines (`<APPNAME>_UNITY_PRECISION_PASS`, ...), so the text
is the same for the same name. `createGodotFlipbookPlayer` (`godot-flipbook`) is the runtime script that plays UV
flipbooks on an imported scene. Native imports are run by the application's own acceptance checks, not here.

## Render to file

`@margoengine/exporters/capture` saves stills, image sequences, animated GIFs and WebM videos (animated PNG and WebP are below). Your code drives time:
each encoder asks `frame(i)` for frame `i`, so set the scene state for that frame there, then call `capture`.

```ts
import {Camera, Engine, box, PbrMaterial} from 'margoengine/core';
import {capture, encodePNG, encodeJPEG, encodeSequence, encodeGIF, encodeWEBM} from 'margoengine/exporters/capture';

// Downloads a file in the browser.
const save = (name: string, data: Uint8Array | Blob) => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data.slice()]));
  link.download = name;
  link.click();
};
const engine = await Engine.create(document.querySelector<HTMLCanvasElement>('canvas')!);
const walker = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color: '#84d6bd'}));
const selected: Camera | null = null;                    // a camera the user picked, if any
const timeline = {seek: (seconds: number) => { walker.position.x = seconds; }};
const camera = new Camera({position: [0, 2, 6], target: [0, 0, 0]});
const orbit = (view: Camera, angle: number) => { view.position = [6 * Math.sin(angle), 2, 6 * Math.cos(angle)]; };

// Still (F12): exact pixels, whatever the window size and device pixel ratio.
const shot = capture(engine, {width: 1920, height: 1080, camera: selected ?? engine.camera});
const png = await encodePNG(shot);                       // Uint8Array, also works in Node
const jpg = await encodeJPEG(shot, 0.9);                 // browser encoder, quality 0..1

// Transparent background: attach TransparentCanvas (@margoengine/environment) first.
const sprite = capture(engine, {width: 256, height: 256, background: '#203040', backgroundAlpha: 0.5});
const topView = capture(engine, {view: engine.views![1]}); // one engine.views entry: its camera, scene and layers, at its rectangle's size

// Movie as numbered files: walk_000.png, walk_001.png ...
const frame = (i: number) => (timeline.seek(i / 30), capture(engine, {width: 640, height: 360}));
for await (const file of encodeSequence(120, frame, {name: 'walk_', pad: 3, format: 'png'}))
  await save(file.name, file.data);

// Spin GIF: 24 frames, 50 ms apart, one full turn.
const gif = await encodeGIF(24, (i) => {
  orbit(camera, (i / 24) * 2 * Math.PI);
  return capture(engine, {width: 320, height: 240, camera});
}, {fps: 1000 / 50});
const webm = await encodeWEBM(120, frame, {fps: 30});    // browser only
```

| Option | Function | Default |
| --- | --- | --- |
| `width`, `height` | `capture` | Required. Output pixels, whole numbers >= 1 |
| `camera` | `capture` | `engine.camera` |
| `background`, `backgroundAlpha` | `capture` | None, 1. Drawn under the scene; shows only where the canvas is transparent. `backgroundAlpha` is Crocotile's Background Transparency (1 opaque, 0 transparent) |
| `name`, `format`, `pad`, `quality` | `encodeSequence` | `'frame'`, `'png'` (or `'jpg'`), 0 digits (`String(count - 1).length` pads every name to one width), 0.92 |
| `fps`, `dither` | `encodeGIF` | 30, `false`. fps at most 50 |
| `fps`, `bitsPerSecond` | `encodeWEBM` | 30, the browser's |

- **Capture.** The canvas is hidden for the call (`display: none`, so `Engine.render` keeps the backing size set by
  `capture`), rendered with `delta: 0`, read back with `drawImage` in the same task, then restored and redrawn through
  the primary camera; the page never shows the capture frame. Pixels are RGBA8, top row first, not premultiplied.
  Sizes above 4096 per side render in tiles through a clip-space view offset on the camera's projection (its own
  `project` hook included); passes that read neighbouring pixels (bloom, SSAO, outlines) can show seams there.
  Pixel-sized lines, points and labels are drawn as at a device pixel ratio of 1. Toggle skyboxes and helpers in the
  scene before capturing; call it outside frame callbacks.
- **GIF.** GIF89a with a NETSCAPE2.0 loop-forever block and a colour table per frame. Frames with at most 256 colours
  (255 with transparency) are exact; others are quantised by median cut over a 5-bit histogram, with optional 4x4
  Bayer dithering. Alpha below 128 is transparent. Delays are whole hundredths, rounded cumulatively (30 fps: 3, 4, 3).
- **JPEG** has no alpha: Chromium writes transparent pixels as black, so capture JPEG frames opaque.
- **WebM** uses MediaRecorder on a `captureStream(0)` canvas with `requestFrame()` per frame, recording each frame for
  1/fps s of wall time and pausing while the next is produced. A throwaway one-frame recording warms the browser's
  media pipeline first (cold, it starts about 1 s late and keeps paused time). Durations follow timers, so they are
  close to 1/fps, and the codec (VP8/VP9) and bit rate are the browser's. Keep the window visible while recording.

### Animated PNG and lossless WebP

`@margoengine/exporters/apng` and `@margoengine/exporters/webp` take the same frame source as `encodeGIF`, keep every
colour and every alpha level exactly, and run anywhere, Node included.

```ts
import {encodeAPNG} from 'margoengine/exporters/apng';
import {encodeAnimatedWebP, encodeWebP} from 'margoengine/exporters/webp';

const red = {data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1};
const clear = {data: new Uint8Array(4), width: 1, height: 1};
const frame = (i: number) => (i % 2 ? clear : red);

const apng: Uint8Array = await encodeAPNG(8, frame, {fps: 12, loops: 0, dispose: 'none', blend: 'source'});
const still: Uint8Array = await encodeWebP(red);
const webp: Uint8Array = await encodeAnimatedWebP(8, frame, {fps: 12, loops: 0});
```

| Option | Applies to | Default |
| --- | --- | --- |
| `fps` | `encodeAPNG` (1000/65535 to 1000), `encodeAnimatedWebP` (1000/16777215 to 1000) | 30. APNG stores a whole rate exactly as 1/fps; other delays are whole milliseconds, rounded cumulatively so the total stays exact |
| `loops` | Both (WebP up to 65535) | 0, loops forever |
| `dispose` | `encodeAPNG`: `'none'`, `'background'`, `'previous'` | `'none'` |
| `blend` | `encodeAPNG`: `'source'` replaces the frame's area, alpha included; `'over'` draws on top | `'source'` |

- **Cut-out sprites.** The defaults replace the whole frame, so a transparent pixel never shows the frame before it.
  GIF does the same with a transparent index and dispose-to-background on every frame.
- **WebP is lossless only here,** written from the WebP lossless specification (VP8L): colour indexing up to 256
  colours, otherwise subtract green and predict, then LZ77 and prefix codes. For lossy WebP use the browser's encoder:
  `canvas.convertToBlob({type: 'image/webp', quality})`. At most 16384 pixels per side.
- Frames of different sizes are refused with a `RangeError`.

### Packed atlases, Godot and Unity 2D

`@margoengine/exporters/atlas` packs images of any size with MaxRects: trimmed borders, padding, extruded edges, a pivot
per frame, several pages. `atlasManifest` writes the JSON hash layout 2D engines read, and `clipFromAtlas`
(`margoengine/sprites/atlas`) turns named frames into a `SpriteAnimation` clip.

```ts
import {atlasManifest, packAtlasFrames} from 'margoengine/exporters/atlas';
import {encodePNG} from 'margoengine/exporters/capture';
import {createGodotTileMapScript, godotSpriteFrames, godotTileCells, godotTileSet} from 'margoengine/exporters/godot-2d';
import {createUnity2DBundle} from 'margoengine/exporters/unity-2d';

const frame = (name: string) => ({name, data: new Uint8Array(16).fill(255), width: 2, height: 2});
const atlas = packAtlasFrames([frame('walk0'), frame('walk1')], {padding: 2, extrude: 1, pivot: {x: 0.5, y: 1}});
const manifest = atlasManifest(atlas, {image: 'hero.png'});
const clips = {walk: {frames: ['walk0', 'walk1'], fps: 8}};

const map = {
  width: 1, height: 1, tileWidth: 16, tileHeight: 16,
  tilesets: [{name: 'ground', firstGid: 1, tileWidth: 16, tileHeight: 16, tileCount: 1, columns: 1,
    image: {source: 'ground.png', width: 16, height: 16},
    tiles: [{id: 0, collision: [{kind: 'rect', x: 0, y: 0, width: 16, height: 16}]}]}],
  layers: [{type: 'tile', name: 'floor', width: 1, height: 1, data: new Uint32Array([1])}],
};

// Godot 4.3: text resources, cells as JSON, and a script that calls set_cell.
const spriteFrames: string = godotSpriteFrames(manifest, clips, {folder: 'res://art'});
const tileSet: string = godotTileSet(map, {folder: 'res://art'});
const cells: string = JSON.stringify(godotTileCells(map));
const script: string = createGodotTileMapScript();

// Unity: copy these files under Assets/Hero, then run Tools > Margo Export > Hero.
const files = createUnity2DBundle({
  folder: 'Hero',
  manifest,
  pages: [await encodePNG(atlas.pages[0])],
  clips,
  map,
  tilesetImages: {'ground.png': new Uint8Array()},
});
console.log(spriteFrames.length, tileSet.length, cells.length, script.length, files.length);
```

| `packAtlasFrames` option | Default |
| --- | --- |
| `trim`: cut transparent borders; offsets go in the manifest | true |
| `padding`: empty pixels between frames | 0 |
| `extrude`: pixels each edge repeats outward | 0 |
| `pivot`: fractions of the untrimmed image; a source's own `pivot` wins | centre |
| `maxSize`: largest page side, up to 16384 | 4096 |
| `powerOfTwo`: round page sides up | false |
| `pages`: most pages to use | 1 |

- **Pivots from Aseprite:** a slice key's pivot is in pixels from the slice, so pass
  `{x: (key.x + key.pivot.x) / width, y: (key.y + key.pivot.y) / height}`.
- **Godot.** Image-collection tilesets are refused (pack them into one image). Godot animates only blocks of consecutive
  atlas cells, so another order is refused. Tile flips use the transform bits of Godot 4.2 and later. `SpriteFrames`
  holds no pivot; set the `AnimatedSprite2D` offset.
- **Unity.** Sprite rects are Y up, and pivots are rebased on the trimmed rect so frames stay put. The C# builds `.anim`
  clips on `SpriteRenderer`, a `MapTile` asset per used tile, and `Map.prefab` with a `Tilemap` and `TilemapCollider2D` per
  layer. Unequal tile frame times repeat frames at their common divisor, since Unity runs a tile at one rate.
- Both engines are checked by hand in the engine, not in CI. Object layers are not exported.

### Sprite atlases and ZIP archives

The capture subpath also packs frames for game engines and downloads. Each takes `signal` (an `AbortSignal`: the call
stops between frames or entries and rejects with its reason, returning nothing partial) and `onProgress(done, total)`.

| Function | Result |
| --- | --- |
| `spriteAtlasLayout(count, frameWidth, frameHeight, columns?, maxSize = 8192)` | `{columns, rows, width, height}`, checked before any frame renders: at most `maxSize` (up to 16384) per side and 8192 x 8192 pixels in all |
| `packSpriteAtlas(count, frame, {columns?, maxSize?})` | The atlas pixels and every frame's rectangle; frame `i` at column `i % columns`, row `floor(i / columns)`, copied exactly at full size (no trimming or filtering), anywhere (no canvas) |
| `encodeZIP(entries, {maxBytes?})` | A stored (uncompressed) ZIP of `{name, data}` (Uint8Array, Blob or UTF-8 string), UTF-8 names, dated 1980-01-01 so the same files give the same bytes; safe relative names only, size checked against `maxBytes` (default 256 MiB, ZIP32 limit 4 GiB) before any entry is read |
| `encodeSequenceZIP(count, frame, {name?, pad?, folder?, manifest?, entries?})` | Numbered lossless PNGs (`frames/frame07.png`) and `manifest.json`; stops as soon as `maxBytes` is spent |
| `encodeAtlasZIP(count, frame, {columns?, image?, manifest?, entries?})` | One atlas PNG and `manifest.json` with each frame's rectangle |

`manifest` is a hook: it receives the base manifest (`format`, sizes, frames) and returns the JSON to write (add clip,
camera or naming fields), or is `false` to leave the file out; `entries` adds files such as a README.

```ts
import {Engine, box, PbrMaterial} from 'margoengine/core';
import {capture, encodeAtlasZIP} from 'margoengine/exporters/capture';

const engine = await Engine.create(document.querySelector<HTMLCanvasElement>('canvas')!);
const walker = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color: '#84d6bd'}));
const frame = (i: number) => {
  walker.rotation.y = (i / 24) * 2 * Math.PI;
  return capture(engine, {width: 64, height: 64});
};
const controller = new AbortController();
const bar = document.querySelector('progress')!;
const zip = await encodeAtlasZIP(24, frame, {
  columns: 6, image: 'walk.png', signal: controller.signal,
  manifest: (base) => ({...base, fps: 12, clip: 'walk'}),
  onProgress: (done, total) => { bar.value = done / total; },
});
```

`node --test packages/exporters/tests/archive.test.js` reads every ZIP back with an independent reader (CRCs, local and
central headers) and decodes the PNGs.

`node --test packages/exporters/tests/capture.test.js` decodes every GIF with an independent GIF89a decoder (exact
pixels, delays, loop, transparency, LZW resets and the end-code width, quantisation error), round-trips PNG through
zlib, and checks capture sizing, tiling and restoring against a mocked canvas.
`node scripts/gpu-lock.mjs run --owner=<id> -- node packages/exporters/tests/capture-browser.mjs` checks a real
WebGPU engine: a 333x111 capture from a 200x150 canvas, 4200x100 tiles against a direct render, transparency, GIFs
decoded by `ImageDecoder`, JPEG and WebM duration.

## Unity asset and support bundles (`@margoengine/exporters/unity`)

The optional Unity delivery module returns files around an unchanged encoded Margo Mesh GLB. Install-once native
support and per-asset exports are separate artifacts. The file APIs never install packages, launch an editor,
access a destination project, resize pixels or rewrite geometry, skin data or animation keys.

```ts
import {exportGLB} from 'margoengine/exporters';
import {createUnityImportBundle, createUnityImportSupportPackage} from 'margoengine/exporters/unity';
import {encodeZIP, encodePNG} from 'margoengine/exporters/capture';

// One quad textured with a 1 x 1 nearest/clamp atlas.
const atlas = await encodePNG({width: 1, height: 1, data: new Uint8Array([200, 120, 60, 255])});
const glb = exportGLB({nodes: [{name: 'Ranger', extras: {id: 'ranger'}, geometry: {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
}, material: {baseColorTexture: {image: atlas, mimeType: 'image/png', magFilter: 'nearest', minFilter: 'nearest',
  mipmaps: false, wrapS: 'clamp', wrapT: 'clamp'}}}]});

const support = await createUnityImportSupportPackage();
const asset = await createUnityImportBundle(glb, {
  folder: 'Assets/Margo/Ranger',
  colliders: true, // default
});
const supportZIP = await encodeZIP(support.entries);
const assetZIP = await encodeZIP(asset.entries);
```

The initial `margo-unity-exact-v1` profile targets Unity 6000.6.7f1, official glTFast 6.20.0 and the exact separately
installed `com.margo.mesh` 0.3.0 support descriptor. Asset files contain `model.glb`, its exact embedded `atlas.png`,
the explicit profile, a hash manifest and instructions. No asset archive contains shared package files or invented
asset GUIDs. Manual extraction can overwrite files; these pure generators cannot inspect or protect a destination.

This focused source profile requires one ordinary RGBA8 power-of-two atlas with explicit nearest/clamp sampling,
one base-color material, complete node identities, authored TRS, ordinary Float32 attributes/weights and explicit
STEP clip FPS/loop metadata. It rejects matrix decomposition, unbound instancing, ambiguous clip names, malformed
skin data and unsupported required collision. It preserves input bytes rather than reducing an unsupported source.
General GLB and other target exports retain their separate capabilities and quality.

The native support uses an isolated public glTFast invocation with explicit source context, public native resource
clones and a mip-free sRGB RGBA32 atlas. It leaves the ordinary raw GLB import untouched. Read the package's
readiness and partial-generation recovery contract before using a generated prefab. A stored report is a snapshot;
the native readiness API must revalidate its current source, support and generated outputs.

Native support 0.3.0 uses an explicit source-clock controller policy and owner schema 2. Ordered clip names,
mesh-file/source-ID mappings and the complete intended resource inventory must remain compatible before an
update writes generated resources. Unsupported controller edits, disabled Animators, deactivated saved prefab
roots and identity changes reject with recovery guidance; existing resources are not silently retargeted or deleted.
Older owner schemas require a fresh target. Supported renderer-disable and Rigidbody overrides retain their
separate preservation policy. Read the support package README for the exact contract.

Version 0.3.0 is under review on the selected development branch. Its source/CPU checks and earlier 0.2.0
texture, source-rest and cancellation evidence do not certify this new native route. Source pixels, complete
geometry/rig poses, reimport/restart, native playback and failure recovery need new bound acceptance before
app installation. No generic GLB, Godot or Roblox quality setting is reduced by this optional support.
