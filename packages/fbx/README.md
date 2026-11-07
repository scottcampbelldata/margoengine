# @margoengine/fbx

Import `margoengine/fbx` from the `margoengine` package, or `@margoengine/fbx` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Native binary and ASCII FBX import through Margo's first-party glTF exporter and optional PBR/animation pipeline. Core, stage, and the animation runtime are unchanged.

```ts
import {loadFBX} from 'margoengine/fbx';
import {Animation} from 'margoengine/animation';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadFBX(engine, '/assets/character.fbx');
const animation = Animation.attach(model);
animation.play('Walking');
```

`convertFBX(bytes, options)` returns a GLB `ArrayBuffer`. `parseFBX(engine, bytes, options)` returns a `PBRModel`. `loadFBX(engine, stringOrURL, options)` fetches an HTTP(S) asset and resolves texture paths against the final response URL. Options remain `{resourcePath?: string; signal?: AbortSignal}`. Explicit resource paths must use HTTP(S).

## Supported first implementation

- A connection naming an object the file left out is dropped: the FBX SDK writes such links, for curves on properties a plug-in owns.
- Binary FBX versions 7100-7700 with 32/64-bit node records, raw arrays, and zlib-compressed arrays. Array headers remain 32-bit in every supported version. ASCII uses the same scene conversion.
- Bounded concave triangulation; normal, UV, tangent/binormal, color, and material layers with Direct/IndexToDirect and ByControlPoint/ByVertice/ByPolygonVertex/ByPolygon/AllSame mappings. The first attribute layer and UV set are imported, or up to four UV sets and two colour layers with the `layers` option; UV V and tangent handedness convert to glTF conventions.
- Area-weighted normals, UV/hard-edge vertex splitting, shared geometry instances, and material partitions. Multiple material partitions become separate child mesh nodes under the original model transform.
- Six fixed-axis Euler orders, pivots/offsets, pre-rotation and inverse post-rotation, mesh-only geometric transforms, units, and signed axis conversion. Missing GlobalSettings preserves raw coordinates. Canonical FBX Y-up uses FrontAxisSign +1; Blender Z-up converts `(x,y,z)` to `(x,z,-y)`.
- Linear Normalize skin clusters, exact joint IDs and bind matrices, four strongest influences with deterministic tie order and normalization, and remapping onto split vertices.
- Single-shape blend channels with sparse position/normal deltas, names, initial weights, and animated percent weights. Blender's all-100 per-control-point FullWeights convention is accepted.
- Lambert/Phong dielectric materials, diffuse/emissive colors, opacity/transparency, shininess-derived roughness, and embedded or external PNG/JPEG diffuse and normal textures. Emission above 1 goes to `KHR_materials_emissive_strength`. An image the server answers 404 or 410 for, or in another format, is left off and named in the material's `extras.fbxMissingTextures`; the model still comes. A full path from the writer's PC is looked for by its file name beside the FBX.
- What real files hold and tools keep: a polygon with a corner repeated (skipped), no area (no triangles) or crossing itself (drawn from its corners); a UV index of -1 (that corner sits at the origin); a joint cluster with no lists; weights for control points the mesh lost after binding (dropped). A file of a skeleton and curves alone, such as Unity's `Name@Clip.fbx`, converts with `convertFBX`; `parseFBX` needs a mesh.
- Multiple animation stacks, one layer per stack (any number with `animationLayers`), STEP and LINEAR curves (every kind with `animationLayers`), missing-axis rest values, and interpolation at common key times. LINEAR transform tracks are adaptively baked for Euler motion and moving pivots, with sampled translation/scale tolerance `1e-5 * max(1, magnitude)` and angular tolerance `1e-4` radians. These are sampling criteria, not a proof of continuous error bounds. Rotation segments are subdivided to preserve full turns.

## UV sets and colour layers

`layers: true` keeps up to four UV sets and two colour layers instead of the first of each, for lightmaps and detail textures. They arrive as `TEXCOORD_0` to `TEXCOORD_3` and `COLOR_0`, `COLOR_1`, in the file's layer order.

```ts
import {loadFBX} from 'margoengine/fbx';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadFBX(engine, '/assets/room.fbx', {layers: true});
console.log(model.primitives.length);
```

A texture whose `UVSet` names a later set samples that set (`texCoord`); the first set, `default` or a name the mesh does not have stays on the first set. The option also works in `convertFBX`, `parseFBX` and the worker entry. Default `false`, which leaves the first set and layer alone and splits vertices on those only.

A vertex that differs in any kept layer is split, so a file with a separate lightmap layout can gain vertices. Sets past the fourth and layers past the second are dropped. gltf-pro draws `COLOR_0` only, so `COLOR_1` is there for your own reader; it packs `TEXCOORD_2` and `3` only when a material reads them.

Proof: a grid from Blender's own exporter with three UV maps and two colour attributes (`test/fixtures/blender-layers.py`) keeps every value Blender reports.

## Scale inheritance

Every inherit type imports, under any ancestor scale, animated or not. Type 1 is a plain parent and child, so it needs nothing extra, and a shear from an uneven scale above a rotation comes out of the chain as it does in the source tool. Type 2 is Maya's segment scale compensate: the child keeps the parent's translation scale and loses its local scale, so it gets a helper node named `<name> inherit` that holds the translation and the inverse of that scale. Type 0 has the helper too when the scale above is uneven or animated, and if a shear sits above it, it leaves for an empty parent named `<root> group` and holds its whole world, baked through every clip. The helper and the group are real nodes in the GLB, so a walk of the tree sees them; rotation order 6 (spherical) reads as XYZ.

```ts
import {loadFBX} from 'margoengine/fbx';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const rig = await loadFBX(engine, '/assets/maya-rig.fbx');
```

Proof: a real Maya rig that mixes types 1 and 2 under uneven animated scale matches all eight frames Maya wrote to the OBJ's six decimals (`test/inherit.test.js`). Type 0 under a shear is by hand-worked result only (stand-in): no real file with it was found.

## Animation layers and cubic curves

`animationLayers` from `margoengine/fbx/layers` reads every kind of curve (cubic with auto, user, weighted and TCB tangents, constant, constant next) and blends a stack's layers, so clips from MotionBuilder and Maya import as authored.

```ts
import {loadFBX} from 'margoengine/fbx';
import {animationLayers} from 'margoengine/fbx/layers';
import {Animation} from 'margoengine/animation';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadFBX(engine, '/assets/take.fbx', {extensions: [animationLayers]});
Animation.attach(model).play('Take 001');
```

A glTF clip here is linear, so a cubic span becomes as many keys as it takes to stay within the baking tolerance above, and a constant key becomes two keys one Float32 step apart. Layers follow their `BlendMode`: additive adds the weighted value, override shows the weighted value and hides what is below, passthrough mixes with what is below. `Weight` and curves on it, `Mute` and `Solo` count. `RotationAccumulationMode` picks quaternions (by layer) or plain angles (by channel), and `ScaleAccumulationMode` picks multiplying, where a weight is a power, or adding. Rotation blends as XYZ on every node, whatever its order: that is what Maya stores.

Without the entry, a file with cubic curves or several layers is refused with an error that says so. Stacks of one layer pass through with no blending, so a turn past 180 degrees stays one.

Proof: Maya's own frame of a file with three layers, weighted by a curve, on cubes of all six rotation orders matches to the OBJ's six decimals (`test/layers.test.js`). Override at a partial weight is by the SDK reference's definition, on hand-written files (stand-in).

## PBR materials and layered textures

`pbrMaterials` from `margoengine/fbx/pbr` reads the physically based materials of Max and Maya as metallic-roughness, instead of the Phong values those tools write beside them.

```ts
import {loadFBX} from 'margoengine/fbx';
import {pbrMaterials} from 'margoengine/fbx/pbr';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadFBX(engine, '/assets/crate.fbx', {extensions: [pbrMaterials]});
console.log(model.primitives.length);
```

| Material | Read |
| --- | --- |
| 3ds Max PBR (`3dsMax\|main\|`) | base colour, metalness, roughness or glossiness by `useGlossiness` (1 glossiness, 2 roughness), emission, base, metal, rough, gloss, normal, occlusion, emission and opacity maps. Specular and gloss materials solve to metalness by the published glTF conversion, from the colours. |
| 3ds Max Physical (`3dsMax\|Parameters|`) | base colour by weight, metalness, roughness with `roughness_inv`, emission by colour, `transparency` as transmission, `trans_ior` as IOR (below 1 it is the same surface from inside, so 1 / IOR), the `_on` switch of each map, and `cutout_map` as alpha. |
| Stingray PBS (`Maya\|`) | base colour, metallic, roughness, emissive by intensity, the `use_x_map` switch of each `TEX_x_map`, `uv_offset` and `uv_scale` on the base colour. |
| Arnold Standard Surface (`Maya\|`) | base colour by weight, metalness, specular roughness, emission, opacity. |
| Lambert and Phong | an `EmissiveColor` map, and a `TransparentColor` map into the base colour's alpha (white is clear; the map's own alpha wins when it has one). |

glTF wants roughness and metalness in one image, so separate maps are decoded and packed, green and blue, into a PNG at the larger size, nearest texel. An opacity map goes into the base colour's alpha: `MASK` at 0.5 when 95 in 100 texels sit at the ends, else `BLEND`. A layered texture flattens to one PNG, first layer at the bottom, each by its blend mode and alpha; add, modulate, modulate 2, darken, lighten, screen, difference and subtract blend, the other modes draw as a plain layer. TGA and TIFF images become PNG.

Texture slots with no glTF place (`bump_map`, `displacement_map`, coat, sheen, anisotropy, subsurface) are left off and named in `extras.fbxUnmappedTextures`. Specular maps of the specular workflow are among them: the colours solve, the map does not. Physical maps replace their value. Texture `uv_scale` reaches the base colour only.

Proof: real files from 3ds Max and Maya give each parameter its own number, and each lands in its slot (`test/pbr.test.js`); the Stingray file embeds its images, so its blue channel is compared with the embedded metal map. Other images are stand-ins, since those files' textures were never published. The order of a layered texture follows the FBX SDK reference and has no render from Maya to compare with.

## NURBS curves and lines

`nurbsCurves` from `margoengine/fbx/curves` keeps the file's NURBS curves and lines. Each sits on its node as `extras.fbxCurve`, in the node's space, and `fbxCurves` hands them back as splines from `@margoengine/geometry/nurbs` for paths, tubes and anything else that takes a curve.

```ts
import {loadFBX} from 'margoengine/fbx';
import {fbxCurves, nurbsCurves} from 'margoengine/fbx/curves';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadFBX(engine, '/assets/route.fbx', {extensions: [nurbsCurves]});
for (const {name, record, curve} of fbxCurves(model.extras())) console.log(name, record.form, curve.getPoint(0.5));
```

The record holds `form` (`Open`, `Closed`, `Periodic`, or `Line` for a polyline), `degree`, `points` (flat xyz, a periodic curve's wrapped ones included), `weights` (one per point, so a rational curve keeps its pull), `knots` and `polyline`. `polyline` is the curve in straight pieces, eight per knot span, ready to draw. The GLB has no line of its own: the curve travels in the node's `extras`, so a viewer that does not read them shows an empty node. `spline(record)` makes one spline from one record.

`nurbsCurves` defaults off: without it a curve is left out, and a file of only curves has nothing to show. FBX NURBS surfaces are not read.

Proof: a real 3ds Max spline passes through every point of the line Max converted it to, the three forms Maya writes close as they say and stay on the circle Maya drew, and a real rational curve bends toward its heavy point (`test/curves.test.js`).

## Skinning modes and in-between shapes

`deformers` from `margoengine/fbx/deformers` reads what the base reader refuses: dual quaternion, blended and rigid skins, `Additive` and `TotalOne` cluster modes, and blend shape channels with more than one shape (Maya's in-betweens).

```ts
import {loadFBX} from 'margoengine/fbx';
import {deformers} from 'margoengine/fbx/deformers';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadFBX(engine, '/assets/hero.fbx', {extensions: [deformers]});
console.log(model.extras().filter((node) => node.extras.fbxSkinning).length);
```

| In the file | Read as |
| --- | --- |
| `DualQuaternion` or `Blend` skin | Plain joints and weights, as glTF has no other kind, with `extras.fbxSkinning` on the node: `{type, blendWeights}`, the share of dual quaternion for each vertex of the output (0 is linear, 1 is all dual quaternion). |
| `TotalOne` clusters | The weights as they stand. |
| `Additive` clusters | Weights that sum under 1 take a new joint that does not move, under a `<skin> group` root with the skeleton, so the vertex keeps its unweighted share at rest. A stand-in: no real file with this mode was found. |
| In-between shapes | One morph target for each shape. The channel walks in straight lines from stop to stop, with the base shape as a stop at 0, and goes on along its end segments past the last stops; `inbetweenWeight(stops, percent, value)` is that sum. Curves on the channel bake to one weight curve for each target. |

A viewer that knows nothing of `extras.fbxSkinning` draws these skins linearly, which is what glTF means, so a dual quaternion skin shows the candy wrapper there. `dualQuaternionSkinning` in `@margoengine/animation/dqs` is whole skin, not per vertex: a `Blend` skin with a mixed share has no runtime in the engine yet, and `skinDualQuaternion` with the share is how the test reaches it.

Proof: all four frames Maya wrote of a real in-between rig match to 0.001 cm, and on a real `Blend` rig the share and the dual quaternion sum meet Maya's frames to 0.05 cm where linear alone misses by more than twice as much (`test/deformers.test.js`).

## Cameras and lights

`sceneExtras` from `margoengine/fbx/scene-extras` keeps the file's cameras and lights: pass it in `extensions` and they load as `model.cameras` and `model.lights`, with the file's lens, clip planes and cone angles, so the shot opens as authored.

```ts
import {loadFBX} from 'margoengine/fbx';
import {sceneExtras} from 'margoengine/fbx/scene-extras';
import {viewGLTFCamera} from 'margoengine/gltf-pro';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadFBX(engine, '/assets/shot.fbx', {extensions: [sceneExtras]});
viewGLTFCamera(model);
console.log(model.cameras.length, model.lights.length);
```

`extensions` default none, and works the same in `convertFBX`, `parseFBX`, `loadFBX` and the worker entry. Without `sceneExtras`, cameras and lights stay plain empty nodes.

Each camera or light sits on a child of its FBX node (`Hero camera`, `Bulb light`) that turns it to glTF's -Z, so curves on the node move it. A perspective camera's vertical field of view follows `ApertureMode` and `GateFit`: with a focal length, from the film and the lens; otherwise from `FieldOfView`, `FieldOfViewY` or a horizontal angle over the aspect. Near and far planes convert with the file's unit. A far plane at or before the near plane means no far plane. An orthographic camera's `OrthoZoom` is the view's full width. The camera that `GlobalSettings` names as `DefaultCamera` carries `extras.defaultCamera`.

Light intensity is FBX's percentage over 100: a value of 100 becomes 1 candela (point, spot) or 1 lux (directional). FBX has no physical unit, so a tool's scale comes through: Blender writes watts x 100, and a 250 W lamp arrives as 250. Change `model.lights[i].intensity` to suit. Area and volume lights become point lights, with the FBX kind in `extras.fbxLightType` and the falloff in `extras.fbxDecayType`, since glTF lights always fall off with the square of distance. `FarAttenuationEnd` becomes `range` when `EnableFarAttenuation` is on.

Not read: curves on camera or light properties (lens, colour, intensity), which are left out and do not stop the import; `LookAtProperty` aim targets; camera switchers. A file holding only cameras and lights converts to a GLB, but `parseFBX` refuses it, as a gltf-pro model needs a mesh.

Proof: two scenes from Blender's own exporter (`test/fixtures/blender-shot.py`), Y up and Z up, match Blender's reported camera and light positions and directions, field of view, clip planes, cone angles, colours and energies. `OrthoZoom` and the `GateFit` rule are proved on Blender's files only.

## Export

`exportFBX` from `margoengine/fbx/export` writes a scene as FBX 7.4, binary by default or ASCII with `ascii: true`. It takes what the other scene exporters take: an engine or a plain data scene.

```ts
import {exportFBX} from 'margoengine/fbx/export';
const geometry = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
};
const {fbx, textures} = await exportFBX({nodes: [{name: 'Triangle', geometry}]});
console.log(fbx.byteLength, textures.size);
```

Options, with defaults: `ascii` false; `embedTextures` true (false names each texture by a relative path and returns its bytes in `textures`, to save beside the file); `signal` none; `maxBytes` 1 GiB, at most 4 GiB less one byte; plus `onlyVisible`, `root`, `geometryData` and `materialData` of every scene exporter.

Written: `GlobalSettings` in centimetres and Y up; polygons with quads kept, per-corner normals, two UV sets and vertex colours, control points welded where position, skin and morph data agree; one material slot per polygon; node hierarchy as `Null`, `Mesh` and `LimbNode` models; Phong materials (metalness goes to `ReflectionFactor` and the specular colour) with base color, normal and emissive textures as embedded PNG or JPEG; skins as `Skin` and `Cluster` deformers; morph targets as `BlendShape` channels; node and weight clips, one `AnimationStack` each. Output is the same bytes on every run.

Changed on the way: rotations become XYZ Euler curves, with keys added where straight Euler lines would leave the quaternion arc by more than about 1e-3 radians. CUBICSPLINE keys are sampled at 8 steps per segment into linear keys. Translation curves scale to centimetres.

Not written, as FBX has no common slot or the data has no file form here: tangents (tools derive them), the metallic-roughness and occlusion textures, texture transforms, material animations, and `extras`. Mixing a material with none in one node's primitives rejects with the fix named.

A node's `camera` and `light` are written, on a child model of the node (`<name> camera`, `<name> light`, or the record's own `name`) that turns glTF's -Z to the +X of an FBX camera and the -Y of an FBX light. The node keeps its own transform, curves and children, and may hold a mesh as well, so a camera or light costs one more node when the file is read back.

```ts
import {exportFBX} from 'margoengine/fbx/export';
const {fbx} = await exportFBX({
  nodes: [
    {name: 'Shot', translation: [0, 2, 8], camera: {type: 'perspective', perspective: {yfov: 0.7, znear: 0.1, zfar: 100, aspectRatio: 1.5}}},
    {name: 'Key', rotation: [-0.383, 0, 0, 0.924], light: {type: 'spot', color: [1, 0.9, 0.8], intensity: 3, range: 20, outerConeAngle: 0.6}},
  ],
});
console.log(fbx.byteLength);
```

A perspective camera is written as a 1 inch film and the lens that gives its `yfov`. `OrthoZoom` is the wider side of the view in metres, in a file of any unit. Light intensity is written as the percentage FBX has, times 100, so 3 is 300; point and spot lights are written with quadratic decay, glTF's fall-off, and `range` as far attenuation. Cone angles are doubled into the whole cone, in degrees. An open far plane has no FBX form: it is written a million near planes out. A camera or light that glTF would refuse is refused here with the same message. Curves on lens, colour or intensity are not written, and a `defaultCamera` flag does not become the file's default camera.

Proof: Blender reads a binary file from `exportFBX` in its own importer, which shares no code with this package. `test/fixtures/blender-read-export.py` prints what landed, and position, aim, up, field of view on both sides, clip planes, ortho scale, light kind, colour, energy, cone and blend all match the scene given.

Children of a node with an uneven scale get `InheritType` 1, the plain parent x local product a scene means. This importer reads them as well. Blender reads binary FBX only, so use the ASCII form with other tools.

`node packages/fbx/test/write-acceptance.js <folder>` writes the files for a manual import check, after a build.

## Explicit limits

Input is capped at 64 MiB, converted GLB at 128 MiB, expanded position vertices at 1,000,000 across mesh instances, and decoded texture pixels at 16,000,000. Parsing also bounds cumulative decoded arrays to 64 MiB, allocation accounting to 128 MiB, node/property counts, hierarchy depth, and work. Geometry, deformation, and animation have additional work/output limits. These are import budgets, not a zero-allocation or peak-heap guarantee. The downstream glTF runtime separately limits GLB/buffer bytes to 64 MiB, so a larger `convertFBX` result may be exportable but cannot be attached by `parseFBX`.

Unsupported data rejects explicitly: an InheritType that does not exist, a shear on a node of its own, Additive/TotalOne, dual quaternion or blended skinning and progressive morphs without `deformers`, layered textures without `pbrMaterials`, and, without `animationLayers`, cubic/mixed/constant-next curves and more than one animation layer. Cameras and lights stay empty nodes without `sceneExtras`. Curves are left out without `nurbsCurves`, and NURBS surfaces, patches and other non-mesh geometry do not produce renderable output. Curves on anything but a node's transform or a blend channel's weight are left out. Extra UV/layer sets and unsupported material maps are omitted. Arbitrary shader graphs are outside the supported material subset.

Array decompression requires platform `DecompressionStream('deflate')`. Image decoding in `parseFBX` requires `createImageBitmap`; `convertFBX` can run headlessly without image decoding. Cancellation is checked during fetch, decompression, parsing, baking, and image decoding; synchronous CPU sections cannot process a newly dispatched abort until the JavaScript event loop resumes.

## Verification and progress

Run `npm test --workspace @margoengine/fbx`. The 53 tests include the original 52 synthetic binary/ASCII, malformed-stream, numeric geometry/bind, and loading regressions, plus a [CC0 Blender-exported rig](test/fixtures/README.md). Its headless test pins three joints, all sixteen inverse-bind values, the clip name, quaternion endpoints, and the runtime bind pose. Tests also use Khronos GLB validation and real `PBRModel`/`Animation` attachment and seek checks. They do not require a test-only decompressor.

`npm run test:modules:browser` requires the checked-in Blender rig by default; the primary CI job explicitly selects that same file. It checks retained skin attributes/deformation buffers, clip playback, changed pixels after playback and seek, and a repeatable first frame. `MARGOENGINE_FBX_FIXTURE` can override its Vite-served URL. The asset's documented export settings exercise the existing subset and do not certify every Blender/Maya/Max convention.

See the implementation plan and progress for completed checks and remaining compatibility work.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/fbx

