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
animation.play(0); // the first clip; a name from animation.clips, such as 'Walking', picks one
```

`convertFBX(bytes, options)` returns a GLB `ArrayBuffer`. `parseFBX(engine, bytes, options)` returns a `PBRModel`. `loadFBX(engine, stringOrURL, options)` fetches an HTTP(S) asset and resolves texture paths against the final response URL. Options remain `{resourcePath?: string; signal?: AbortSignal}`. Explicit resource paths must use HTTP(S).

## Supported first implementation

- A connection naming an object the file left out is dropped: the FBX SDK writes such links, for curves on properties a plug-in owns.
- Binary FBX versions 7100-7700 with 32/64-bit node records, raw arrays, and zlib-compressed arrays. Array headers remain 32-bit in every supported version. ASCII uses the same scene conversion; its strings keep backslashes raw, as Autodesk's files write paths, and spell a quote `&quot;`, in both the reader and `exportFBX`.
- Bounded concave triangulation; normal, UV, tangent/binormal, color, and material layers with Direct/IndexToDirect and ByControlPoint/ByVertice/ByPolygonVertex/ByPolygon/AllSame mappings. The first attribute layer and UV set are imported, or up to four UV sets and two colour layers with the `layers` option; UV V and tangent handedness convert to glTF conventions.
- Area-weighted normals, UV/hard-edge vertex splitting, shared geometry instances, and material partitions. Multiple material partitions become separate child mesh nodes under the original model transform.
- Six fixed-axis Euler orders, pivots/offsets, pre-rotation and inverse post-rotation, mesh-only geometric transforms, units, and signed axis conversion. Missing GlobalSettings preserves raw coordinates. Canonical FBX Y-up uses FrontAxisSign +1; Blender Z-up converts `(x,y,z)` to `(x,z,-y)`.
- Linear Normalize skin clusters, exact joint IDs and bind matrices, up to eight influences a vertex (past four, the second four go in `JOINTS_1` and `WEIGHTS_1`), the eight strongest kept with deterministic tie order and normalized together, and remapping onto split vertices.
- Single-shape blend channels with sparse position/normal deltas, names, initial weights, and animated percent weights. Blender's all-100 per-control-point FullWeights convention is accepted.
- Lambert/Phong dielectric materials, diffuse/emissive colors, opacity/transparency (`Opacity`, else `TransparentColor` x `TransparencyFactor`), roughness from `ShininessExponent` (or the older `Shininess`), and embedded or external PNG/JPEG diffuse and normal textures. Emission above 1 goes to `KHR_materials_emissive_strength`. An image the server answers 404 or 410 for, or in another format, is left off and named in the material's `extras.fbxMissingTextures`; the model still comes. A full path from the writer's PC is looked for by its file name beside the FBX.
- What real files hold and tools keep: a polygon with a corner repeated (skipped), no area (no triangles) or crossing itself (drawn from its corners); a UV index of -1 (that corner sits at the origin); a joint cluster with no lists; weights for control points the mesh lost after binding (dropped). A file of a skeleton and curves alone, such as Unity's `Name@Clip.fbx`, converts with `convertFBX`; `parseFBX` needs a mesh.
- What Character Creator 4 writes: shapes whose normal deltas are garbage (NaN, or values near 1e149; a normal delta cannot pass 2 on any axis) take them from their positions instead, as the moved mesh's area-weighted normals less the rest mesh's, at every control point whose normal turns; a curve on the scene root (object 0, which has no node) that holds it at rest is left out, and one that moves it is refused; a texture path that climbs above the server's root (`../../../../../../Users/.../FbxWorkingDirectory/x.jpg`) is looked for by its file name beside the FBX, while one that stays on the server is still refused unless `allowedURLs` holds it.
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

A vertex that differs in any kept layer is split, so a file with a separate lightmap layout can gain vertices. Sets past the fourth and layers past the second are dropped. gltf/pbr draws `COLOR_0` only, so `COLOR_1` is there for your own reader; it packs `TEXCOORD_2` and `3` only when a material reads them.

Proof: a grid from Blender's own exporter with three UV maps and two colour attributes (`test/fixtures/blender-layers.py`) keeps every value Blender reports.

## Scale inheritance

Every inherit type imports, under any ancestor scale, animated or not. Type 1 is a plain parent and child, so it needs nothing extra, and a shear from an uneven scale above a rotation comes out of the chain as it does in the source tool. Type 2 is Maya's segment scale compensate: the child keeps the parent's translation scale and loses its local scale, so it gets a helper node named `<name> inherit` that holds the translation and the inverse of that scale. The scale taken away is the parent's signed `Lcl Scaling`, so a mirrored parent leaves its child unmirrored, and a scale curve that holds a value other than the rest one counts as animated. Type 0 has the helper too when the scale above is uneven or animated, and if a shear sits above it, it leaves for an empty parent named `<root> group` and holds its whole world, baked through every clip. The helper and the group are real nodes in the GLB, so a walk of the tree sees them; rotation order 6 (spherical) reads as XYZ.

```ts
import {loadFBX} from 'margoengine/fbx';
import {animationLayers} from 'margoengine/fbx/layers';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
// This Maya file animates with cubic curves, which the base reader refuses (see Animation layers below).
const rig = await loadFBX(engine, '/assets/maya-rig.fbx', {extensions: [animationLayers]});
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
| Stingray PBS (`Maya\|`) | base colour, metallic, roughness, emissive by intensity, the `use_x_map` switch of each `TEX_x_map`, `uv_offset` and `uv_scale` on every map the shader samples (base colour, metallic-roughness, normal, occlusion and emissive), with V turned for glTF (offset V becomes 1 - scale V - offset V). |
| Arnold Standard Surface (`Maya\|`) | base colour by weight (`base` 0.8 when the file leaves it out, as Standard Surface sets it), metalness, specular roughness, emission as `emission` x `emissionColor`, opacity. |
| Lambert and Phong | an `EmissiveColor` map (scaled by `EmissiveFactor`), and a `TransparentColor` map into the base colour's alpha. It reads as opacity (white opaque), as 3ds Max, Blender and Character Creator write it, unless the material's `TransparencyFactor` is 1, Maya's way, where white is clear; the map's own alpha wins when it has one. A map with no hole leaves the material opaque. |

glTF wants roughness and metalness in one image, so separate maps are decoded and packed, green and blue, into a PNG at the larger size, nearest texel. An opacity map goes into the base colour's alpha: `MASK` at 0.5 when 95 in 100 texels sit at the ends, else `BLEND`. A layered texture flattens to one PNG, first layer at the bottom, each by its blend mode and alpha; add (1), modulate (2), modulate 2 (3), darken (7), lighten (11), screen (12), difference (22) and subtract (24) blend, by the FBX SDK `EBlendMode` numbers, and the other modes, hard mix and exclusion among them, draw as a plain layer. A layer whose image is missing drops out with its mode and alpha. TGA and TIFF images become PNG.

Texture slots with no glTF place (`bump_map`, `displacement_map`, coat, sheen, anisotropy, subsurface) are left off and named in `extras.fbxUnmappedTextures`. Specular maps of the specular workflow are among them: the colours solve, the map does not. Physical maps replace their value; an emission map replaces the emission colour and keeps the family's emission weight, so a weight of 0 stays dark. A Stingray `uv_scale` and `uv_offset` reach every map it covers.

Proof: real files from 3ds Max and Maya give each parameter its own number, and each lands in its slot (`test/pbr.test.js`); the Stingray file embeds its images, so its blue channel is compared with the embedded metal map. Other images are stand-ins, since those files' textures were never published. The order of a layered texture follows the FBX SDK reference and has no render from Maya to compare with.

## Character Creator materials

Character Creator writes a `.json` beside its FBX with what the FBX has no slot for. `characterCreator(json, {base})` from `margoengine/fbx/character-creator` reads it after `pbrMaterials`: each named material gets its exported roughness and metallic maps packed into glTF's metallic-roughness image, its AO map as occlusion (with the map's strength), a normal map the FBX lacks and its two-sided flag. The eye occlusion shell (`RLEyeOcclusion`) becomes the soft shadow along the lids that sets the eye in its socket, from the shader's own numbers: per edge of the opening the shadow's width as a share of the eye (`Shadow Top`, `Shadow Bottom`, the corners), the share of it that fades (`Range`), how far it follows the lid's curve (`Arc`), its strength and colour, and a narrower, darker `Shadow2` under the top lid. The shell's top rows tuck under the lid skin, so the top shadow starts at the lid margin a front view sees: each shell vertex is tested against the head's skin (`RLHead`) along the shell's own outward direction (Moller and Trumbore 1997), the margin is found by bisection on the shell edges between hidden and seen vertices, and the shell's v is moved per u so the margin is v 0 (`anchorLidShadow(shell, skin, front)` does it for any mesh). Only an edge running down the shell from a hidden end counts as the top margin: the shell's corners tuck wholly under the canthus skin, and an edge across from a hidden corner column crosses the side of the opening, which had put Wilbur's corners 0.16 to 0.49 of the shell down. Columns with no top crossing follow the least-squares parabola of those that have one, the arc an upper lid keeps to its corners. Without it the darkest part of the shadow lay under the skin: Wilbur's shells open at v 0.03 to 0.09 across the eye, where the shadow had already fallen from 0.62 to 0.38 opacity. glTF blends over the eye, so a shadow colour of luminance L at strength s darkens by s (1 - L), unlit. The tear line (`RLEyeTearline`) becomes a clear strip with the shader's roughness, which shows as a glint on the lower lid. Skin (`RLHead`, `RLSkin`) gets its micro detail as roughness: the shader's `Micro Roughness Scale` is added to the roughness map, then the slope variance of its `MicroNormal` map at `MicroNormal Strength` (times the red of `MicroNormalMask`) is added to alpha squared, as LEAN mapping filters detail far below a pixel (Olano and Baker 2010; Toksvig 2005). Pores are a fraction of a millimetre across, so on screen they only widen the highlight: without them the bare roughness map left a smooth oiled sheen on the skin in sunlight. `microNormalVariance(image)` gives a normal map's slope variance. The head shader's region roughness scales are read too: `Nose`, `Mouth`, `UpperLid` and `InnerLid Roughness Scale` over the red to alpha of its `Nose Mouth UpperInnerLid Mask`, `Cheek`, `Forehead`, `UpperLip` and `Chin` over `Cheek Fore UpperLip Chin Mask`, `Ear` and `Neck` over `Ear Neck Mask` (Targa files, read with `margoengine/decoders/tga`), and `Unmasked Roughness Scale` where no mask reaches; the body's `RLSkin` takes the four channel scales over its `RGBA Area Mask`. Each is added to the roughness where its mask is, before the micro normals widen it, so a default head's wet upper lids (-0.3) keep a sheen the drier cheeks lose.

```ts
import {Engine} from 'margoengine';
import {loadFBX} from 'margoengine/fbx';
import {pbrMaterials} from 'margoengine/fbx/pbr';
import {characterCreator} from 'margoengine/fbx/character-creator';
const engine = await Engine.create(document.querySelector('canvas')!);
const url = new URL('/assets/character.json', location.href);
const cc = characterCreator(await (await fetch(url)).json(), {base: url});
const model = await loadFBX(engine, '/assets/character.fbx', {extensions: [pbrMaterials, cc]});
```

Paths without a folder name images the FBX embeds, which the base reader already took. `read` replaces `fetch` for the exported maps (a file system, a zip), and a missing map leaves the material as the FBX has it. It runs with `loadFBX` and `convertFBX` on the page; the worker entry takes extensions by name, so it does not carry the json. Not read yet: the head shader's region roughness and scatter scales, wrinkle maps, the micro normal and the subsurface and transmission maps (`@margoengine/materials/skin` draws the scatter from its own profile).

Proof: a json built in Character Creator's layout lands each map in its glTF slot, leaves unnamed materials and missing maps alone, widens skin roughness by the micro normals' slope variance after the micro roughness scale, and draws the lid shadow darkest under the top lid in the middle, clear at the centre of the eye, more at the tear duct than the outer corner (`test/character-creator.test.js`); the lid margin is found within a hundredth of the shell and the corners keep it when the skin hides whole corner columns, the shadow there is the full top shadow (0.620 against 0.624), and from the margin down the shell alone is never darker than a measured real eye while giving at least half of its darkening at the margin (`test/eye-margin.test.js`).

## NURBS surfaces and patches

`surfaces` from `margoengine/fbx/surfaces` tessellates FBX NURBS surfaces and the five patch bases (Bezier, BezierQuadric, Cardinal, BSpline, Linear) into triangle meshes, with exact normals, parameter UVs and optional end caps. `Step` in the file sets the quads per knot span.

```ts
import {convertFBX} from 'margoengine/fbx';
import {surfaces} from 'margoengine/fbx/surfaces';
const glb = await convertFBX(await (await fetch('/assets/nurbs-plane.fbx')).arrayBuffer(), {extensions: [surfaces]});
const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, new DataView(glb).getUint32(12, true))));
console.log(json.meshes[0].primitives[0].attributes);
```

Blend shapes and skins on a surface move its control points, as Maya and the FBX SDK do. A blend shape becomes a glTF morph target that is exact at every weight, in-betweens included: the surface is linear in its control points, so each vertex moves by its basis share of each moved point. Its normals are the deformed surface's own at full weight, as a mesh shape's are. A skin is exact where the control points a vertex reaches carry one weight set, as with a rigid bind or one shared blend; there the vertex takes that set. Where they carry different sets, the exact vertex needs each joint at a bind position of its own, and a glTF skin has one position a vertex. So each joint whose weight changes across those points gets four helper joints, children of it named `<joint> blend 0` to `3` that follow it exactly, whose inverse binds add the corners of a tetrahedron around the vertex; their weights place each joint's own bind position, and the skin is exact in every pose. Two such joints at one vertex fit in eight influences. Three, a joint whose share of a vertex goes below zero (a Cardinal patch's negative coefficients), or a blend in an `Additive` or `TotalOne` cluster is refused with the remedy (convert the surface to polygons and bind those) rather than approximated.

Proof: real Maya surfaces and every basis tessellate on both front ends, and the morph of a rational biquadratic net matches its Bernstein basis written out by hand, position and normal, at every vertex. A two-joint blend on that net, posed and skinned by the glTF formula from the GLB, matches the control net skinned point by point and then evaluated, within 4e-6, with and without a geometric transform, and the file passes the Khronos validator (`test/surfaces.test.js`).

## NURBS curves and lines

`nurbsCurves` from `margoengine/fbx/curves` keeps the file's NURBS curves and lines. Each sits on its node as `extras.fbxCurve`, in the node's space, and `fbxCurves` hands them back as splines from `@margoengine/geometry/nurbs` for paths, tubes and anything else that takes a curve.

```ts
import {convertFBX} from 'margoengine/fbx';
import {fbxCurves, nurbsCurves} from 'margoengine/fbx/curves';
// A file of curves alone has no mesh for loadFBX, so convert it and read the nodes of the GLB it makes.
const glb = new Uint8Array(await convertFBX(await (await fetch('/assets/route.fbx')).arrayBuffer(), {extensions: [nurbsCurves]}));
const json = new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer).getUint32(12, true)));
const nodes = (JSON.parse(json).nodes as {name?: string; extras?: Record<string, unknown>}[]).map((node) => ({name: node.name, extras: node.extras ?? {}}));
for (const {name, record, curve} of fbxCurves(nodes)) console.log(name, record.form, curve.getPoint(0.5));
```

The record holds `form` (`Open`, `Closed`, `Periodic`, or `Line` for a polyline), `degree`, `points` (flat xyz, a periodic curve's wrapped ones included), `weights` (one per point, so a rational curve keeps its pull), `knots` and `polyline`. `polyline` is the curve in straight pieces, eight per knot span, ready to draw. A `Line` also has `pieces`, the number of `polyline` points in each separate polyline: FBX ends one at each negative point index, and its spline breaks there too. The GLB has no line of its own: the curve travels in the node's `extras`, so a viewer that does not read them shows an empty node. `spline(record)` makes one spline from one record.

`nurbsCurves` defaults off: without it a curve is left out, and a file of only curves has nothing to show. FBX NURBS surfaces are read by `surfaces`, above.

Proof: a real 3ds Max spline passes through every point of the line Max converted it to, the three forms Maya writes close as they say and stay on the circle Maya drew, and a real rational curve bends toward its heavy point (`test/curves.test.js`).

## Skinning modes and in-between shapes

`deformers` from `margoengine/fbx/deformers` reads what the base reader refuses: dual quaternion, blended and rigid skins, `Additive` and `TotalOne` cluster modes, and blend shape channels with more than one shape (Maya's in-betweens).

```ts
import {loadFBX} from 'margoengine/fbx';
import {deformers} from 'margoengine/fbx/deformers';
import {animationLayers} from 'margoengine/fbx/layers';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
// This file also animates with cubic curves, so it needs animationLayers beside deformers.
const model = await loadFBX(engine, '/assets/hero.fbx', {extensions: [deformers, animationLayers]});
console.log(model.extras().filter((node) => node.extras.fbxSkinning).length);
```

| In the file | Read as |
| --- | --- |
| `DualQuaternion` or `Blend` skin | Plain joints and weights, as glTF has no other kind, with `extras.fbxSkinning` on the node: `{type, blendWeights}`, the share of dual quaternion for each vertex of the output (0 is linear, 1 is all dual quaternion). |
| `TotalOne` clusters | The weights as they stand. |
| `Additive` clusters | Weights that sum under 1 take a new joint that does not move, under a `<skin> group` root with the skeleton, so the vertex keeps its unweighted share at rest. A stand-in: no real file with this mode was found. |
| In-between shapes | One morph target for each shape. The channel walks in straight lines from stop to stop, with the base shape as a stop at 0, and goes on along its end segments past the last stops; `inbetweenWeight(stops, percent, value)` is that sum. Curves on the channel bake to one weight curve for each target. |

A viewer that knows nothing of `extras.fbxSkinning` draws these skins linearly, which is what glTF means, so a dual quaternion skin shows the candy wrapper there. `dualQuaternionSkinning` in `@margoengine/animation/dqs` is whole skin, not per vertex: a `Blend` skin with a mixed share draws with `Animation.attach(model, {skinning: blendSkinning})` from `@margoengine/animation/dqs`, which reads `extras.fbxSkinning.blendWeights` per vertex (sketched in the animation README).

Proof: all four frames Maya wrote of a real in-between rig match to 0.001 cm, and on a real `Blend` rig the share and the dual quaternion sum meet Maya's frames to 0.05 cm where linear alone misses by more than twice as much (`test/deformers.test.js`).

## Cameras and lights

`sceneExtras` from `margoengine/fbx/scene-extras` keeps the file's cameras and lights: pass it in `extensions` and they load as `model.cameras` and `model.lights`, with the file's lens, clip planes and cone angles, so the shot opens as authored.

```ts
import {loadFBX} from 'margoengine/fbx';
import {sceneExtras} from 'margoengine/fbx/scene-extras';
import {viewGLTFCamera} from 'margoengine/gltf/pbr';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadFBX(engine, '/assets/shot.fbx', {extensions: [sceneExtras]});
viewGLTFCamera(model);
console.log(model.cameras.length, model.lights.length);
```

`extensions` default none, and works the same in `convertFBX`, `parseFBX`, `loadFBX` and the worker entry. Without `sceneExtras`, cameras and lights stay plain empty nodes.

Each camera or light sits on a child of its FBX node (`Hero camera`, `Bulb light`) that turns it to glTF's -Z, so curves on the node move it. A perspective camera's vertical field of view follows `ApertureMode` and `GateFit`: with a focal length, from the film and the lens; otherwise from `FieldOfView`, `FieldOfViewY` or a horizontal angle over the aspect. Near and far planes convert with the file's unit. A far plane at or before the near plane means no far plane. An orthographic camera's `OrthoZoom` is the view's full width. The camera that `GlobalSettings` names as `DefaultCamera` carries `extras.defaultCamera`.

Light intensity is FBX's percentage over 100: a value of 100 becomes 1 candela (point, spot) or 1 lux (directional). FBX has no physical unit, so a tool's scale comes through: Blender writes watts x 100, and a 250 W lamp arrives as 250. Change `model.lights[i].intensity` to suit. Area and volume lights become point lights, with the FBX kind in `extras.fbxLightType` and the falloff in `extras.fbxDecayType`, since glTF lights always fall off with the square of distance. `FarAttenuationEnd` becomes `range` when `EnableFarAttenuation` is on.

Not read: curves on camera or light properties (lens, colour, intensity), which are left out and do not stop the import; `LookAtProperty` aim targets; camera switchers. A file holding only cameras and lights converts to a GLB, and `parseFBX` loads it as a gltf/pbr model with no mesh and its `cameras` and `lights`.

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

Written: `GlobalSettings` in centimetres and Y up; polygons with quads kept, per-corner normals, two UV sets and vertex colours, control points welded where position, skin and morph data agree; a second set of four influences (`joints1`) goes into the same clusters; one material slot per polygon; node hierarchy as `Null`, `Mesh` and `LimbNode` models; Phong materials (metalness goes to `ReflectionFactor` and the specular colour) with base color, normal and emissive textures as embedded PNG or JPEG; skins as `Skin` and `Cluster` deformers; morph targets as `BlendShape` channels; node and weight clips, one `AnimationStack` each. Output is the same bytes on every run.

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

A perspective camera is written as a 1 inch film and the lens that gives its `yfov`. `OrthoZoom` is the wider side of the view in metres, in a file of any unit. Light intensity is written as the percentage FBX has, times 100, so 3 is 300; point and spot lights are written with quadratic decay, glTF's fall-off, and `range` as far attenuation. Cone angles are doubled into the whole cone, in degrees. An open far plane has no FBX form: it is written a million near planes out. A camera or light that glTF would refuse is refused here with the same message. Curves on cameras and lights are written from `propertyClips` (below). The camera whose `extras.defaultCamera` is true becomes the file's `DefaultCamera`, which `sceneExtras` flags again on reading; FBX names it by its model, so two cameras flagged under different names, or an unflagged camera sharing the name, throw a `TypeError`. Default none.

A lens pull or a light fade is a `propertyClips` entry, each curve on the node that carries the camera or light. Camera curves: `yfov` (perspective only, above 0 and below PI, written as both `FieldOfView` and the `FocalLength` it gives), `znear` and `zfar` in metres (`NearPlane`, `FarPlane`). Light curves: `intensity`, `color` (three values per key), `range` in metres (`FarAttenuationEnd`; a point or spot light that sets `range`), and a spot's `innerConeAngle` and `outerConeAngle` in radians from the axis (written as the whole cone in degrees). A property a curve drives is flagged animatable. A clip shares the stack of a node clip with the same `name`, or makes its own. Keys are `STEP` or `LINEAR`.

A curve on a node that holds no matching camera or light, a `yfov` on an orthographic camera, a `range` or cone curve on a light that has none, or two curves on one property in a clip throw a `TypeError`. A key outside the values glTF allows the property, a `zfar` that does not stay above `znear`, or an outer cone that does not stay above the inner one (checked at every key and just before it, against the other value's curve or its resting value) throws a `RangeError`.

```ts
import {exportFBX} from 'margoengine/fbx/export';
const shot = {name: 'Shot', camera: {type: 'perspective' as const, perspective: {yfov: 0.8, znear: 0.1, zfar: 100}}};
const key = {name: 'Key', light: {type: 'point' as const, color: [1, 0.9, 0.8], intensity: 3}};
const {fbx} = await exportFBX({nodes: [shot, key]}, {
  propertyClips: [{name: 'Rack', channels: [
    {node: shot, property: 'yfov', times: [0, 2], values: [0.8, 0.4]},
    {node: key, property: 'intensity', times: [0, 2], values: [3, 0]},
    {node: shot, property: 'znear', times: [0, 2], values: [0.1, 1]},
  ]}],
});
console.log(fbx.byteLength);
```


Proof: Blender reads a binary file from `exportFBX` in its own importer, which shares no code with this package. `test/fixtures/blender-read-export.py` prints what landed, and position, aim, up, field of view on both sides, clip planes, ortho scale, light kind, colour, energy, cone and blend all match the scene given.

Children of a node with an uneven scale get `InheritType` 1, the plain parent x local product a scene means. This importer reads them as well. Blender reads binary FBX only, so use the ASCII form with other tools.

`node packages/fbx/test/write-acceptance.js <folder>` writes the files for a manual import check, after a build.

## Explicit limits

Input is capped at 64 MiB, converted GLB at 128 MiB, expanded position vertices at 1,000,000 across mesh instances, and decoded texture pixels at 16,000,000. Parsing also bounds cumulative decoded arrays to 128 MiB, allocation accounting to 128 MiB, node/property counts, hierarchy depth, and work. Geometry, deformation, and animation have additional work/output limits. These are import budgets, not a zero-allocation or peak-heap guarantee. Measured on the defaults (`test/large.test.js`, `test/default-scale-browser.mjs`): a 996,004-vertex mesh whose every corner is its own vertex, with normals, a UV set and tangents in a zlib-compressed binary file, converts to one glTF primitive and attaches with `parseFBX`, on WebGPU and on the WebGL2 layer; gltf/pbr draws it as parts of at most 262,144 vertices (its default `maxPartVertices`), one draw each, which together hold every vertex and every triangle once (a vertex on a cut is stored in each part that uses it, under 1% extra; `test/part-coverage.js`). The geometry build holds about 94 B per corner for such a mesh (24 B per control point, 8 B per corner, 12 B per triangle corner, 28 B plus 4 B per float per vertex), so the 128 MiB scene cap is not what stops it; the 1,000,000-vertex cap is, and past it `largeFBX` raises every cap together. A file whose arrays are not compressed reaches the 64 MiB input cap first, at about 860,000 such vertices. The downstream glTF runtime separately limits GLB/buffer bytes to 64 MiB, so a larger `convertFBX` result may be exportable but cannot be attached by `parseFBX`.

Unsupported data rejects explicitly: an InheritType that does not exist, a shear on a node of its own, Additive/TotalOne, dual quaternion or blended skinning and progressive morphs without `deformers`, layered textures without `pbrMaterials`, and, without `animationLayers`, cubic/mixed/constant-next curves and more than one animation layer. Cameras and lights stay empty nodes without `sceneExtras`. Curves are left out without `nurbsCurves`, NURBS surfaces and patches without `surfaces`, and other non-mesh geometry does not produce renderable output. Curves on anything but a node's transform or a blend channel's weight are left out. Extra UV/layer sets and unsupported material maps are omitted. Arbitrary shader graphs are outside the supported material subset.

Array decompression requires platform `DecompressionStream('deflate')`. Image decoding in `parseFBX` requires `createImageBitmap`; `convertFBX` can run headlessly without image decoding. Cancellation is checked during fetch, decompression, parsing, baking, and image decoding; synchronous CPU sections cannot process a newly dispatched abort until the JavaScript event loop resumes.

## Verification and progress

Run `npm test --workspace @margoengine/fbx`. The 53 tests include the original 52 synthetic binary/ASCII, malformed-stream, numeric geometry/bind, and loading regressions, plus a [CC0 Blender-exported rig](test/fixtures/README.md). Its headless test pins three joints, all sixteen inverse-bind values, the clip name, quaternion endpoints, and the runtime bind pose. Tests also use Khronos GLB validation and real `PBRModel`/`Animation` attachment and seek checks. They do not require a test-only decompressor.

`npm run test:modules:browser` requires the checked-in Blender rig by default; the primary CI job explicitly selects that same file. It checks retained skin attributes/deformation buffers, clip playback, changed pixels after playback and seek, and a repeatable first frame. `MARGOENGINE_FBX_FIXTURE` can override its Vite-served URL. The asset's documented export settings exercise the existing subset and do not certify every Blender/Maya/Max convention.

See the implementation plan and progress for completed checks and remaining compatibility work.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/fbx

### Loading into a second scene

`parseFBX`, `loadFBX`, `parseFBXInWorker` and `loadFBXInWorker` remember the scene that is active when you call them, before their first await, and build the model there, though the conversion and the texture decoding finish later. Start it inside a second scene's plugin `setup` (or any code running while that scene is set up) and what it makes belongs to that scene; start it anywhere else and it belongs to the default scene. An abort leaves nothing in either scene.
