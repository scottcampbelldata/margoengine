# @margoengine/exporters

glTF 2.0 / GLB, STL, OBJ (with MTL), PLY, static USDZ and static COLLADA 1.4.1 (`.dae`) export for Margo Engine scenes
and plain geometry data, plus SHA-256 for checking exported files.

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

Engine exports recognize primitives loaded by `@margoengine/gltf-pro` and `@margoengine/fbx`, without attaching core geometry. glTF/GLB retain all primitives on each node and their bind-pose skin/morph data; other formats write base geometry. Automatic export of PBR textures (a textured `createMesh` mesh included: use `exportModel`), material extensions, and more than four skin influences throws explicitly. An engine forest containing no supported mesh geometry also throws; visibility filtering and intentionally empty data scenes remain supported.

Engine export entrypoints also bake back-only optional PBR triangles by reversing winding and negating base and morph normals. This preserves their visible side in glTF, GLB, USDZ, OBJ, PLY and STL, including mirrored world transforms. Front-only and double-sided materials retain their existing geometry behavior.

- **Scene walk.** An engine source is walked through `engineRuntime(engine)`: `meshes`, `store.parents`, `store.hidden` and the local transforms in `store.transforms` (translation, quaternion, scale). World matrices are recomputed in double precision from the parent chain, so export does not depend on a `render()` having run. Hidden meshes hide their descendants, as in the kernel.
- **Every Margo Engine mesh is a glTF node.** Transform-only meshes become empty nodes, so the hierarchy survives. With `flatten`, each drawable mesh is a root node with its world transform; when a parent chain with non-uniform scale produces shear, which glTF TRS cannot hold, that mesh's world transform is baked into its vertices (and winding is flipped for mirrors).
- **Deduplication.** One `Geometry` (or geometry data object) is written once: POSITION (with exact Float32 `min`/`max`), NORMAL, optional TANGENT, TEXCOORD_0 and COLOR_0, and indices. One glTF mesh is written per geometry and material pair, and one glTF material per `PbrMaterial`. Images are deduplicated by byte array.
- **Materials.** `PbrMaterial.data` maps to `pbrMetallicRoughness`: `baseColorFactor` is already linear, then `roughnessFactor`, `metallicFactor` and `doubleSided`. Material data adds emission, alpha mode, base color, metallic-roughness, normal, occlusion and emissive textures, and `KHR_materials_transmission`, `KHR_materials_ior` and `KHR_materials_emissive_strength`.
- **Binary layout.** Each bufferView starts on a 4-byte boundary, the buffer length is a multiple of 4, GLB JSON is padded with spaces and BIN with zeros. Indices are 16-bit up to 65535 vertices (65535 itself is the restart value) and 32-bit above. Normals and tangents are normalized and tangent `w` is forced to +1 or -1, as the validator requires.
- **STL, OBJ, PLY** write world-space data. STL uses face normals from the transformed triangle. OBJ writes one `g` group (or `o` object) per mesh, `v`/`vt`/`vn` and 1-based `f v/vt/vn` faces, with `vt` flipped to OBJ's v-up. The MTL has `Kd` and `Ke` in sRGB plus `Pr`, `Pm`, `d` and optional `map_Kd`/`map_d`. PLY merges all meshes into one vertex and face list, with optional 8-bit sRGB colors from vertex colors or the material.
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
| `materials`, `mtlName` | OBJ | `false`, `'scene.mtl'` |
| `colors` | OBJ, PLY | `false`. OBJ appends sRGB vertex colors to `v` lines; PLY writes uchar `red green blue` |
| `colorSpace` | OBJ | `'srgb'`. `'linear'` writes the vertex colors unconverted |
| `textures`, `texturePrefix` | OBJ | `false`, `''`. With `materials`, writes `map_Kd` (plus `map_d` for MASK/BLEND) and returns the images in `textures` |
| `groups` | OBJ | `true`, one `g` per mesh; `false` writes `o` objects |
| `mergeVertices` | OBJ | `false`. Welds a mesh's corners whose position, uv, normal and written color agree within 1e-5 |
| `scale` | OBJ | `1`. Multiplies every position |

`GeometryData` is `{positions, normals, uvs?, tangents?, colors?, indices?, faceSizes?, joints?, weights?, morphs?}` with xyz, xyz, uv, xyzw and linear rgb or rgba per vertex. `uvs` follow glTF (v = 0 at the image's top, images as encoded): a materials mesh's v-up UVs go in as `1 - v`. `faceSizes` lists corners per face in index order: 3 for a triangle, 4 for the next two triangles when they form a quad (sharing an edge, as (a, b, c), (a, c, d)); OBJ and DAE write those quads as 4-corner faces, the other formats write the triangles. Inputs are validated: finite Float32 values, matching lengths, complete triangles, indices in range, colors in [0, 1], nonzero scales (or [0, 0, 0], below) and quaternions, PNG or JPEG bytes that match `mimeType`, and textured materials only on geometry with the UV set they sample.

### Retaining hidden nodes

Data-scene `ExportNode.retainedVisibility` writes `KHR_node_visibility` without filtering the node, geometry or descendants. Omit it for the default visible fallback; explicitly set `false` for a hidden collision helper whose geometry and socket nodes must survive export. The extension is listed in `extensionsUsed`, not `extensionsRequired`. Existing `visible: false` still controls `onlyVisible` filtering. Retained visibility needs hierarchy export; `flatten: true` rejects it with a `TypeError`.

```ts
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

## OBJ textures and quads

```ts
const {obj, mtl, textures} = exportOBJ(scene, {
  materials: true, mtlName: 'level.mtl', textures: true, texturePrefix: 'textures/',
  colors: true, colorSpace: 'linear', mergeVertices: true, groups: false, scale: 16,
});
for (const [path, bytes] of textures) save(path, bytes); // e.g. 'textures/tileset.png', relative to the OBJ
```

Texture files are named from `TextureData.name` (unsafe characters become `_`, a trailing `.png`/`.jpg` is dropped)
or `texture_<n>`, with `.png` or `.jpg` from the `mimeType`; one image's bytes become one file, and a name already
taken gets `_2`, `_3`. The files are the `TextureData` bytes as given. `texturePrefix` may hold letters, digits,
`_ . - /`.

## COLLADA (.dae)

`exportDAE(engineOrDataScene, options)` from `@margoengine/exporters/dae` (or the package root) returns
`{dae, textures}`: a COLLADA 1.4.1 document (Y up, meters) and its image files keyed by their path relative to the
`.dae`. Options are the scene options plus `colorSpace` (`'srgb'` default or `'linear'`, for vertex colors) and
`texturePrefix`, named as for OBJ.

```ts
import {exportDAE} from '@margoengine/exporters/dae';

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
const pixels = {image: pngBytes, mimeType: 'image/png', magFilter: 'nearest', minFilter: 'nearest', mipmaps: false};
const glb = exportGLB({nodes: [
  {geometry, material: {baseColorTexture: pixels, unlit: true}},
  {translation: [0, 3, 0], light: {type: 'point', color: [1, 0.9, 0.7], intensity: 40, range: 10}},
  {translation: [0, 1, 6], camera: {type: 'perspective', perspective: {yfov: 0.8, znear: 0.1}}},
]});
```

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
  set (default `uvs1`). Standard viewers ignore it; an import script binds it.

```ts
import {exportGLB, paletteTexture} from '@margoengine/exporters';

const palette = await paletteTexture(rgbaBytes);             // {texture, size, uvs}
const geometry = {positions, normals, uvs, uvs1, colors, indices};
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
const clip = {fps: 12, frames: [0, 4, 8], end: 12};
const cels = [{name: 'Prop_Cel1', primitives: bank0}, {name: 'Prop_Cel2', primitives: bank1}];
const prop = {name: 'Prop', children: cels};
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

```ts
const withColliders = appendGLBMeshes(glb, [
  {name: 'Body-colonly', positions: hull, indices, volume: true, extras: {role: 'collision'}},
]);
```

## Godot import bundle (`@margoengine/exporters/godot`)

`createGodotImportBundle(glb, options)` returns owned files around an already encoded Margo GLB. It does not rewrite
the GLB, run Godot or change the project settings. Copy the returned folder into the root of an existing project
without renaming it; the seed `.glb.import` refers to the generated script at that fixed `res://` location. Godot
creates its own UID and cache paths. The caller can package the entries with the existing public ZIP encoder:

```ts
import {createGodotImportBundle} from '@margoengine/exporters/godot';
import {encodeZIP} from '@margoengine/exporters/capture';

const bundle = await createGodotImportBundle(glb, {
  folder: 'margo_exports/waystone',
  convexHelperIds: ['exported-helper-id'], // default []
  // fps: 24, // required when exported clips have mixed or missing extras.fps
});
const zip = await encodeZIP(bundle.entries);
```

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

## Skin authoring (`@margoengine/exporters/skin`)

An optional subpath (nothing else imports it) that skins a mesh to an authored rest skeleton:

| Function | Result |
| --- | --- |
| `checkJoints(joints)` | Throws unless 1 to 1024 joints `{name, parent, position}` form one tree with one root (`parent: -1`) |
| `skinWeights(positions, joints, {origin?, influences?})` | `{joints: Uint16Array, weights: Float32Array}`, four per vertex: the `influences` (default 4) nearest bone segments (parent to joint; the root's is its point), inverse-distance weights summing to 1, ties to the lower joint index. Points so far away that distances overflow are measured in a scaled space, so every finite point gets positive weights |
| `skinBindMatrices(joints, origin?)` | Column-major `local`, `world` and `inverseBind` rest matrices, 16 values per joint |
| `skinHierarchy(joints, {origin?, name?})` | Joint `ExportNode`s (`root`, `nodes`) and the `SkinData` for the mesh node, skeleton set |
| `humanoidJoints(min, max)` | An 18-joint upright humanoid rest skeleton fitted to a box (y up, facing +z), to refine by hand |

Coordinate conventions: joint positions are in joint space, the mesh's vertices in mesh space, and `origin` is the
joint-space point at the mesh's origin (joint = mesh + origin; a voxel model's pivot when joints are grid
coordinates). Matrices are column-major. Joints have no rest rotation: each local rest transform is the translation
from its parent (the root's from the mesh origin) and each inverse bind matrix the translation by minus the joint's
mesh-space position, so the rest pose leaves every vertex in place. Put `root` beside the mesh node, under the same
parent.

```ts
import {humanoidJoints, skinHierarchy, skinWeights} from '@margoengine/exporters/skin';

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
import {SHA256, sha256} from '@margoengine/exporters/hash';

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

## Limits

The engine/data-scene `exportGLTF` and `exportGLB` entrypoints write cameras, lights, extras and
`KHR_materials_unlit`, `KHR_materials_transmission`, `KHR_materials_ior`, `KHR_materials_emissive_strength`, and
base-color `KHR_texture_transform` with its `KHR_animation_pointer` clips only from data-scene nodes and materials, and no
instancing or other KHR material extensions; use `exportModel` for loaded glTF-pro camera/light attachments and PBR
metadata. Export does not produce Draco or meshopt compression, sparse
accessors or interleaved buffers. Engine/data-scene skins support four influences per vertex. `exportGLTF` puts images
in the buffer rather than separate image files. PLY writes every vertex as given; OBJ welds only whole
corners (`mergeVertices`), never `v`, `vt` and `vn` separately. Node names are not made unique. The existing `@margoengine/gltf` loader accepts what these exporters write from
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

## Render to file

`@margoengine/exporters/capture` saves stills, image sequences, animated GIFs and WebM videos. Your code drives time:
each encoder asks `frame(i)` for frame `i`, so set the scene state for that frame there, then call `capture`.

```ts
import {capture, encodePNG, encodeJPEG, encodeSequence, encodeGIF, encodeWEBM} from '@margoengine/exporters/capture';

// Still (F12): exact pixels, whatever the window size and device pixel ratio.
const shot = capture(engine, {width: 1920, height: 1080, camera: selected ?? engine.camera});
const png = await encodePNG(shot);                       // Uint8Array, also works in Node
const jpg = await encodeJPEG(shot, 0.9);                 // browser encoder, quality 0..1

// Transparent background: attach TransparentCanvas (@margoengine/environment) first.
const sprite = capture(engine, {width: 256, height: 256, background: '#203040', backgroundAlpha: 0.5});

// Movie as numbered files: walk_000.png, walk_001.png ...
const frame = (i) => (timeline.seek(i / 30), capture(engine, {width: 640, height: 360}));
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
const zip = await encodeAtlasZIP(24, frame, {
  columns: 6, image: 'walk.png', signal: controller.signal,
  manifest: (base) => ({...base, fps: 12, clip: 'walk'}),
  onProgress: (done, total) => bar.set(done / total),
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
import {createUnityImportBundle, createUnityImportSupportPackage} from '@margoengine/exporters/unity';
import {encodeZIP} from '@margoengine/exporters/capture';

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
