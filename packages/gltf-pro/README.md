# Margo Engine glTF Pro

Import `margoengine/gltf-pro` from the `margoengine` package, or `@margoengine/gltf-pro` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

`Picking.attach(engine)` from `@margoengine/selection` discovers loader-owned
primitive nodes automatically. `selection.set([primitive.node])` also discovers
their model; explicit `add(model)` remains supported and is deduplicated.
Custom buffer providers still register explicitly. Both consume `model.pickingPrimitives`,
which borrows the current static or GPU-deformed buffers and alpha metadata.
Registration changes no beauty shader, vertex layout or material bindings.

`model.readPickingGeometry()` returns an asynchronous, independently owned CPU
snapshot for `Raycaster.intersectModel(model)` in `@margoengine/bvh`. Static
geometry uses CPU copies; animated geometry is copied from the actual GPU output.
The optional `prepareDeformation` hook encodes the latest pose before reading,
without advancing animation time. Snapshots include world matrices, indices,
material sides and identity (`primitiveIndex` in `model.primitives`, absent for
point and line primitives, and the glTF `nodeIndex` when it has one) captured
with the query,
before any readback. Restoration, disposal or replacement of
an in-flight deformation output invalidates the result and releases staging
buffers. Caller-provided deformation buffers need `COPY_SRC` for CPU snapshots.

Use `import {GLTFAsset} from '@margoengine/gltf-pro/asset'` for accessor decoding
without loading PBR rendering or its shaders. The root export retains the same
constructor; `GLTFDocument` is available as a type from either entry.
`@margoengine/gltf-pro/splats` exports `gaussianSplats` and `readGaussianSplats` ([below](#gaussian-splats-in-gltf-splats)).
`@margoengine/gltf-pro/coordinates` exports `textureCoordinates` and the `TextureTransform` type (also on the root)
for material extensions that read texture coordinates without loading the renderer.

Optional WebGPU glTF 2.0 metallic-roughness rendering, separate from the frozen core and stage. The public npm name follows this repository's scope: `@margoengine/gltf-pro`.

Core + stage must remain below **25,000 bytes gzip**; CI rejects 25,000 bytes and above. Optional loaders, decoder code, workers and Wasm stay outside that measurement.

```ts
import {createStage} from 'margoengine';
import {loadGLTF, type MaterialExtension} from 'margoengine/gltf-pro';
const stage = await createStage('#viewport', {backend:'webgpu'});
const model = await loadGLTF(stage.engine, '/SciFiHelmet.glb');
const b = model.bounds;
stage.engine.camera.fitToBoundingBox([b[0],b[1],b[2]], [b[3],b[4],b[5]]);
// Call model.destroy() when unloading the model, or stage.dispose() on unmount.
```

`KHR_node_visibility` sets each node's `visible` flag, also when the extension is required. A hidden ancestor hides the meshes and lights below it; transforms, animation, sockets and cameras keep working. Toggle `model.nodes[index].visible` to change it. `model.clusteredLights()` leaves out lights under hidden nodes. After changing visibility, call `applyGLTFLights(model)` again to refresh the imported sun; if the model no longer has a visible sun, the lighting from before goes back, unless the caller changed it since. `@margoengine/animation/pointer` plays animated visibility (`KHR_animation_pointer`).

Supports base color/alpha, metallic-roughness (G/B), normal maps, occlusion (R), emissive, vertex colors, UV sets 0 to 3, tangents or derivative tangent frames, alpha masking/blending, double-sided materials, GLB/external buffers/images, normalized and sparse accessors. GGX, Smith, and Schlick implement analytical direct lighting with hemispherical ambient fill. Canvas output uses ACES Filmic tone mapping and sRGB encoding; HDR captures remain linear. Color/emissive textures decode sRGB; other maps remain linear. Images have generated mip chains and honor glTF filtering and wrapping.

Loaded triangle materials expose live `side: 'front' | 'back' | 'double'`, initialized from glTF's `doubleSided`.
For example, `model.primitives[0].material.side = 'back'` switches to back-only rendering next frame. Mirrored
nodes and mixed mirrored instances retain local winding. Picking and beauty/auxiliary passes agree on sides;
points and lines ignore triangle sides. Shadow casters retain their existing two-sided policy. `exportModel`
in `@margoengine/exporters` bakes back-only winding and normals into glTF-compatible geometry.

Set `primitive.material.wireframe = true` to draw triangle edges as one-pixel WebGPU lines. The flag is live,
defaults to false, and applies to beauty, auxiliary, transparency, capture and shadow passes, including groups,
instances and deformed vertices. Each triangle contributes all three edges, so shared edges blend twice on
transparent surfaces. Points and existing lines keep their topology. Lines ignore triangle face culling and
polygon bias. Edge index buffers are allocated on first use, reused across toggles, and released on restoration
or disposal. Picking, CPU snapshots and glTF export retain the original filled triangle geometry; glTF has no
wireframe material flag. Directional sources registered with `Shadows.add(source, {static: true})` require the
existing `Shadows.invalidate()` call after a live toggle; automatically cached casters update themselves.

`primitive.material.renderState` supplies beauty-only blend/depth overrides, polygon bias, stencil face states,
masks/reference, `colorWrite` and `alphaToCoverage` (MASK materials on a multisampled target: edges cut by sample coverage). Bias defaults to literal WebGPU values; `depthBiasMode: 'away'` keeps positive
offsets away from the camera across main reverse-Z and forward-Z device views. `stencilReference` is live per draw
and reuses pipelines. Native front/back stencil states follow raster winding. Different face operations temporarily
use the original primitives instead of winding-normalized static batches; symmetric state restores batching.
Stencil requires a stencil attachment;
`StencilBuffer` from `@margoengine/materials` supplies one for the scene when needed. Auxiliary/capture replays,
picking and shadows retain their existing behavior. See the [material controls](../materials/README.md#polygon-offset-and-stencil)
for constructor options, target boundaries and transmission behavior. glTF export omits these render controls.

`loadGLTF` automatically decodes `KHR_draco_mesh_compression` primitives and
`EXT_meshopt_compression` buffer views and `KHR_texture_basisu` textures using `@margoengine/decoders`, installed as
a dependency. Draco workers and Wasm start only when compressed primitives are
encountered and are released after decoding, including on failure or cancellation.
Meshopt decoding is synchronous and cached per buffer view, including views used
by skin, morph and animation accessors. Unknown required extensions still fail.

For in-memory JSON or GLB bytes, use `await parseGLTFAsync(engine, input)` or pass an options object as the third
argument, for example `{buffers, signal, draco, ktx2}`. Both forms decode embedded PNG/JPEG and KTX2 images;
external buffers and images resolve against the page. Passing `undefined` as the third argument alone behaves like
omitting it. Decoded bitmaps close with the model, or before rejection on decode, size-limit, cancellation or attachment
failure.

The positional `await parseGLTFAsync(engine, input, buffers, images, {signal, draco, ktx2})` overload keeps supplied
ordinary bitmaps and decodes embedded KTX2 when needed. Passing `undefined` for buffers with a fourth or fifth argument
retains this positional behavior. Use the no-options/options-object form for automatic ordinary image decoding.
The existing `parseGLTF(engine, input, buffers, images)` remains synchronous for
uncompressed and meshopt assets; Draco input directs callers to the async API.
Both async APIs accept `{signal}`, an optional reusable `draco` decoder with a
`decode` method, and an optional `ktx2` decoder with a `transcode` method. A supplied decoder stays owned by its caller. The default Draco
decoder requires browser module workers; server callers can supply a decoder.
Draco attributes and indices populate the original accessors, preserving skin and
morph data and leaving attributes outside the compression map on the usual path.
Normalized integer UVs, colors and extra channels are converted once according to
their accessor metadata; decoding leaves the caller's glTF document unchanged.

KTX2 transcodes are lazy, preserve every mip level, and choose BC7, ASTC, ETC2 or
RGBA8 from the device's enabled features. Color/emissive roles use sRGB formats;
data maps use linear formats. Loader-owned workers terminate after decoding,
including failure and abort. Retained mip bytes support device restoration without
another transcode. `KHR_texture_basisu.source` takes precedence over a PNG fallback.
The positional `parseGLTFAsync` overload decodes embedded/data-URI KTX2; use the options-object overload or `loadGLTF`
for external images.
Synchronous `parseGLTF` also accepts already decoded `GLTFImage` blueprints.

`KHR_texture_transform` supports offset, rotation, scale, and the overriding UV set
on all five PBR maps. UV0 and UV1 already share the fixed 80-byte vertex layout. A draw fetches only the parts of that vertex its finished shader reads, so a material with no maps
reads position, normal and, while `vertexColors` is on, colour. Nothing to set.
Nonidentity transforms append affine rows to group 3 alongside any caller material
factors. Identity transforms and ordinary UV0 materials retain the exact original
shader, 400-byte frame, and groups 0/1. Normal maps derive their tangent frame from
transformed or secondary UVs; alpha-masked directional shadows use the same mapping.
Optional material maps support the same transform through `materials.install()`.
`textureCoordinates(info)` exposes the validated UV selection and packed affine rows;
caller-owned clearcoat/transmission textures accept a glTF-style `transform` option.

`KHR_animation_pointer` is accepted when required. gltf-pro loads the pointer channels as data; `Animation` from
`@margoengine/animation`, given `pointerChannels` from `@margoengine/animation/pointer`, plays them on the model's live
values (node transforms and weights, material factors and
texture transforms, `model.lights`, `model.cameras`, node visibility) and lists the pointers it skips in
`animation.warnings`. Lights and cameras are data: hand them on after each update.

```ts
import {createStage} from 'margoengine';
import {applyGLTFLights, loadGLTF, viewGLTFCamera} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
import {pointerChannels} from 'margoengine/animation/pointer';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/pointer-show.glb'); // extensionsRequired: ['KHR_animation_pointer']
const animation = Animation.attach(model, {pointers: pointerChannels});
animation.playing = false;
animation.seek(0.5); // writes material factors, light and camera values
viewGLTFCamera(model, 0); // the animated yfov
applyGLTFLights(model); // the animated sun; pass {clustered} for point and spot lights
```

`loadGLTF` and `parseGLTFAsync` shade a file that uses clearcoat, transmission, IOR, volume, dispersion, sheen, specular, iridescence, anisotropy, diffuse transmission, volume scatter or a bump map with the physical renderer by default: they import `extendedMaterials` from `@margoengine/gltf-pro/extended` on first need, so an app whose files never use those extensions ships none of its WGSL. Pass `{decoders: {materials: false}}` to keep the base shader (the extensions are then ignored, as glTF allows), or your own `extendedMaterials`. For synchronous parsing, pass `{materials: extendedMaterials}` as `parseGLTF`'s fifth argument. The imported metadata also stays available for explicit `@margoengine/materials` installation, whose lobes replace the physical renderer for the materials they cover. Constructed `@margoengine/materials` meshes retain their live material and UV-transform layout automatically.

`KHR_materials_dispersion` is accepted when required. Its factor is validated and
retained as `primitive.material.dispersion` even without a materials decoder;
it defaults to 0 and accepts finite non-negative values, including values above 1.
With `extendedMaterials`, declaring the extension reserves the physical frame even
at 0. Chromatic refraction is visible through `@margoengine/materials/transmission`
when transmission and volume thickness are positive. Dispersion alone does not
reserve transmission. The factor remains live, and 0 preserves the existing
refraction output. Native transmission uses scalar volume thickness; imported
`KHR_materials_volume.thicknessTexture` is sampled by the explicit
`@margoengine/materials` installation route.

The optional `/worker` entry exposes `loadGLTFInWorker` and `parseGLTFInWorker`. Ordinary assets parse and pack in a worker. Automatic Draco/KTX2 inputs transfer their source buffers back before codec work, then decode on the GPU-owning thread; custom decoders or `fetch` keep the entire load there. The `/progressive` loader exposes `ready` and `complete`; compressed assets use the normal async loader before publishing a model, and its `textures` option streams KTX2 mip levels ("Texture mip streaming" below). `maxDownloadBytes`, `maxNodes`, allowed resource URLs and abort signals remain enforced; `maxDownloadBytes` counts the root JSON/GLB file together with its fetched and data-URI resources.

In a multi-view frame, a model draws only the nodes in the view's layers, and each view keeps its own camera uniforms
even when one command encoder records several views or probe faces. Buffers released mid-draw (a callback that
disposes the model) stay valid until the frame is submitted.

The loader passes declared vertex/index counts, accessor widths and the remaining
256 MiB decoded-data budget into Draco. The default decoder rejects oversized
actual geometry before allocating output arrays, including topology without an
index accessor. It still needs to decode internal Wasm geometry before reading
those counts. Custom `draco.decode` hooks should honor the supplied `limits`;
the loader also validates returned data before constructing GPU resources.

`parsePreparedPBR(engine, document, geometry, images)` accepts a static glTF-style scene/material document and per-mesh arrays of `PreparedGeometry` (`vertices: Float32Array`, `indices: Uint32Array`). Vertices use the existing 80-byte layout: position4, normal4, tangent4, UV0+UV1, color4. Arrays are validated and retained without repacking; keep them immutable until destruction, or replace them with `model.writeGeometry(geometry, range?)`. This path has no accessors, skins or animations and is used by the separate `@margoengine/blender` loader. Existing glTF loading and animation APIs are unchanged.

`model.writeGeometry(geometry)` takes one `PreparedGeometry` per entry of `model.primitives` and swaps them in place: GPU buffers are rewritten while the new data fits and reallocated at twice their size otherwise. With `range` (`{start, count}` in vertices) only those vertices changed: vertex and index counts stay and only that range uploads (pass new array objects when positions moved, so BVH and selection caches keyed on them refresh). Nodes, materials and plugin registrations stay; static batches are retired and edited primitives cast dynamic shadows. Skinned, morphed and `shareBuffers` primitives are refused, and `createRenderer` replicas keep their original geometry. `@margoengine/materials` meshes wrap it as `mesh.setGeometry`.

Transmissive materials honour their maps on the default path too: a black half of a `transmissionTexture` hides the light behind it, and `metallicRoughnessTexture`, base colour, sheen, clearcoat and iridescence all change how much passes. That takes a second textured draw per glass surface; [docs/limits.md](../../docs/limits.md) has the measured cost.

`KHR_materials_specular` and `KHR_materials_ior` reach every light: direct, `Clustered` local lights, `EnvironmentLighting`, `LightProbes` and sky ambient. A lighting hook reads them as `s.f0` and `s.sw`; on shaders without those fields `lightPBR` writes 0.04 and 1 in their place.

Attach animation with the separate animation package. Register this model with `ssao.add(model)` to include its mapped normals and ambient lighting in SSAO. Neither extension is imported by this package. Disposal and device restoration retain CPU asset blueprints.

Optional consumers use one weak triangle-source registry across separately bundled packages. Inspector and line helpers use bind-pose positions/normals with current transforms; static spatial queries and shadow mesh registrations also retain loader-owned primitives. `mesh.geometry` remains null, so core does not receive a second drawable. Physics fits static primitive nodes or a geometry-free model root's descendants without changing the hierarchy; skinned or morphed meshes require explicit colliders. glTF export retains supported skin/morph attributes. Disposal clears registry entries, and reused mesh slots cannot inherit them.

`model.raw` borrows one live GPU record per primitive (`vertex`, `index`, `count`,
`stride: 80`, node and alpha metadata), including current deformation. `bounds`
scans bind-pose CPU positions through current node matrices. Fit these bounds
through `camera.fitToBoundingBox`; the frozen stage's `fit(meshes)` and internal
raw adapter continue to support core geometry only. Active deformation requires
the asynchronous pose snapshot for accurate CPU raycasts.

### Mixed core/PBR scene helpers

Import the optional `@margoengine/gltf-pro/scene` entry for camera fitting and
raw GPU records across core geometry and loaded glTF/FBX models:

```ts
import {createStage} from 'margoengine';
import {box} from 'margoengine/core';
import {loadGLTF, type MaterialExtension} from 'margoengine/gltf-pro';
import {getSceneBounds, fitScene, gatherSceneBuffers} from 'margoengine/gltf-pro/scene';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/SciFiHelmet.glb');
const coreMesh = stage.engine.createMesh().setGeometry(box());
const roots = [model.root, coreMesh];
fitScene(stage.engine, roots, {duration: 0.3, padding: 1.1});
const bounds = getSceneBounds(stage.engine, roots);
const buffers = gatherSceneBuffers(stage.engine, roots);
```

Each selected root includes its descendants. Overlapping selections visit each
node once. Hidden meshes and meshes under hidden ancestors are excluded by
default; `{visibleOnly: false}` includes them. Frustum culling does not affect
selection. Bounds scan actual CPU positions under current world transforms;
skinned/morphed positions remain the bind pose. Empty bounds throw `No geometry`.
`fitScene` returns the bounds used and accepts `aspect`, `duration`, and `padding`;
aspect defaults to the displayed canvas dimensions, falling back to its size.

`gatherSceneBuffers` returns one record per core node or PBR primitive, preserving
distinct nodes/primitives even when they share GPU buffers. Records include
`kind`, `node`, a borrowed world `matrix`, `vertex`, `index`, index `count`, and
`indexFormat: 'uint32'`. Core records have `stride: 24`, `geometry`, and the shared
batch `instance` buffer. That instance buffer reflects the last render and does
not provide a stable instance offset for an individual node. PBR records have
`stride: 80`, primitive identity, and alpha/UV metadata.

These records borrow existing resources: do not destroy their buffers or modify
their matrices. Requery after animation or device restoration to obtain current
buffers; gathering does not encode animation, upload geometry, or read back the
GPU. An empty selection returns `[]`; WebGL2 returns `null`. Foreign/disposed
roots and unavailable GPU resources report errors. The frozen `Stage.fit` and
internal facade adapter retain their original contracts.

`model.lods` lists a file's `MSFT_lod` objects (`node`, `levels`, `screenCoverage`): the level nodes load though no scene names them, under the first level's parent, hidden, until `LOD.fromModel` from `margoengine/lod` drives them.

Register with `shadows.add(model)` and `clustered.add(model)` for optional directional shadows and local PBR lights, including the current skinned vertex buffer. `addLighting()` accepts an optional shader/binding hook without importing these packages. `shadowPrimitives` exposes current opaque/masked GPU geometry to depth consumers; blended materials are omitted. A material's `displacement` (materials' `displacementMap`: its feature uniform, view and sampler) is passed on with each of its primitives so depth passes displace them as the beauty pass does (`shared/displacement.js`).

`primitive.material.shading` accepts one `LightingEffect` for that material's
surface shader and group 2 bindings. Constructed materials use it so geometry
groups can share a model while retaining separate textures and shading. It
composes before `addLighting()` effects and applies to beauty, g-buffer,
ambient and capture draws; its resources must remain in the selected entry
point's static resource interface. `extension.lighting: false` suppresses
scene lighting while retaining the material's own shading. Callbacks own their
resources and must recreate them after device restoration. Cross-device
renderers reject local shading until the caller recreates it for that device;
same-device renderers can reuse it. Its optional `lit(code)` rewrites the shader
after the `addLighting()` effects are composed in (materials' Lambert and Phong
put their own BRDF in clustered's light loop there); returning `code` changes
nothing.

### More than two UV sets

A texture may read `TEXCOORD_0` to `TEXCOORD_3`, as Blender writes them for a material on its third or fourth UV map. Only a primitive whose material (or a `KHR_materials_variants` mapping) reads set 2 or 3 pays: it gets a second vertex buffer, `primitive.uvs`, four floats a vertex, and its own shader. A file that merely carries those attributes loads as before. The 80-byte vertex stays as it is.

```ts
import {loadGLTF} from 'margoengine/gltf-pro';
import type {Engine} from 'margoengine';
declare const engine: Engine;
const model = await loadGLTF(engine, '/models/FourUV.glb');
// TEXCOORD_2 then TEXCOORD_3 of each vertex, present only when a material reads either.
console.log(model.primitives[0].uvs);
```

`loadGLTFInWorker`, `loadGLTFProgressive`, Draco, `EXT_mesh_gpu_instancing`, `@margoengine/lod` levels and far meshes, and `@margoengine/exporters` all keep the later sets. `writeGeometry` keeps them too: a write that changes the vertex count passes its own `uvs`. Such primitives stay out of static batches. A `MASK` or `BLEND` base map on set 2 or 3 casts and picks uncut, as the depth passes read the first two sets only, and a `.margo` file holds two sets. A fifth set is refused by name.

### Scattering in glTF volumes (`KHR_materials_volume_scatter`, draft)

`loadGLTF` and `parseGLTFAsync` read `KHR_materials_volume_scatter` by themselves through `@margoengine/gltf-pro/extended`, so milky glass, jade and wax look solid where the light has far to go and clear where it has not. It needs `KHR_materials_volume` with a thickness and an `attenuationDistance`, and light that enters: `KHR_materials_transmission` or `KHR_materials_diffuse_transmission`. Otherwise it does nothing, as the spec has it. `multiscatterColorFactor` (default `[0, 0, 0]`) times `multiscatterColorTexture` (sRGB) is the multi-scatter colour; `scatterAnisotropy` (default `0`, from -1 to 1) moves scattering forward or back.

```ts
import {parseGLTF} from 'margoengine/gltf-pro';
import {extendedMaterials} from 'margoengine/gltf-pro/extended';
import type {Engine} from 'margoengine';
declare const engine: Engine;
declare const doc: object;
// The default loaders need none of this; the synchronous parser takes the decoder by hand.
const model = parseGLTF(engine, doc, [], [], {materials: extendedMaterials});
console.log(model.primitives[0].material.extended?.scatter);
```

This is a rasterizer's reading, with no light walked through the medium. Over the depth x, which is `thicknessFactor` times the green channel of `thicknessTexture` along the surface normal, a share 1 - exp(-sigma_s (1 - g) x) of the entering light scatters and comes back as a diffuse lobe of the multi-scatter colour, with sigma_s from the spec's albedo mapping. A dense medium therefore matches a diffuse surface of that colour, the comparison the spec itself draws. Light does not spread sideways under the surface, so edges stay sharp. Specular transmission keeps its Beer-Lambert term, which already counts what scattered out of the straight path. Diffuse transmission had none, so it is scaled by what crosses the depth. For the view through the glass to refract, and for `KHR_materials_volume` thickness maps on that view, use `install(model)` from `@margoengine/materials`, which reads this extension too.

The text read is the draft of Khronos glTF pull request 2453 (Status "Draft") as of 2026-11-06: it can still change, and pull request 2579 proposes `KHR_materials_scatter` in its place. The multi-scatter colour and thickness maps count toward the eight extension textures of an extended material. Phase function detail beyond the 1 - g scale is not drawn.

### Bump maps in glTF (`EXT_materials_bump`, draft)

`loadGLTF` and `parseGLTFAsync` read `EXT_materials_bump` by themselves through `@margoengine/gltf-pro/extended`: the red channel of `bumpTexture`, read as linear data, times `bumpFactor` is a height, and the surface normal becomes `normalize(n - grad d)`. It tilts the normal a normal map has already tilted, so a file can hold large forms in the normal map and fine detail in the bump map. `heightSpace: 'object'` scales the height with the node, along the surface normal, so uneven scale works too; `'world'` keeps it in metres. Without `heightSpace` the draft leaves the strength to the renderer: Margo reads it as `'world'`.

```ts
import {parseGLTF} from 'margoengine/gltf-pro';
import {extendedMaterials} from 'margoengine/gltf-pro/extended';
import type {Engine} from 'margoengine';
declare const engine: Engine;
declare const doc: object;
// The default loaders need none of this; the synchronous parser takes the decoder by hand.
const model = parseGLTF(engine, doc, [], [], {materials: extendedMaterials});
console.log(model.primitives[0].material.extended?.bump);
```

This follows the draft of Khronos glTF pull request 2339 as it stood on 2026-11-04, Status "Draft": it can still change. The height has one row in the extended uniform and the map is one of the eight extension textures of an extended material, so a ninth loses its bump.

### Gaussian splats in glTF (`/splats`)

A file with `KHR_gaussian_splatting` primitives loads through plain `loadGLTF` or `parseGLTFAsync`: the meshes draw as usual, and the splats go to `@margoengine/splats`, so a captured scene and modelled objects share one file, one loader and one depth buffer. Nothing to pass: `@margoengine/gltf-pro/splats` and `@margoengine/splats` load only for a file that holds splats, and the worker loaders read such a file on the page's thread. `@margoengine/splats` is an optional peer dependency; a splat file without it stops with an error that names it.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
import {type MaterialExtension} from 'margoengine/gltf-pro';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/capture.glb', {maxDownloadBytes: 2 ** 28});
const b = model.bounds; // takes in the splat centres
stage.engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]]);
console.log(model.splats.map(({cloud}) => cloud.count));
// model.dispose() disposes the clouds too.
```

Read against the extension's README (Complete, Ratified by the Khronos Group, as of 2026-11-06) and the draft `KHR_gaussian_splatting_compression_spz_2` (Draft, pull request 2531, as of the same day). Every attribute type of the `ellipse` kernel reads, with spherical harmonics up to degree 3, both colour spaces (`srgb_rec709_display`, `lin_rec709_display`), and the draft's SPZ payload through `parseSpz`. A file written against the draft may leave `kernel` and `colorSpace` out; they then take `ellipse` and `srgb_rec709_display`. A file that breaks the extension's rules, such as a band of harmonics with a coefficient missing, is refused with the fault named. An unknown kernel or colour space is refused too.

- `model.splats` holds `{cloud, bounds}` per cloud. Each primitive is placed by its node's world matrix (centres, shapes and harmonics), then the file's primitives merge into one cloud, so they sort together. Splats past 3,000,000 start another cloud.
- `{decoders: {splats: false}}` keeps the extension's fallback: the primitive draws as plain points, or a file that requires the extension is refused. Synchronous `parseGLTF` does the same.
- `readGaussianSplats(asset, primitive, {signal})` from `@margoengine/gltf-pro/splats` returns one primitive's `SplatData` in local space with no GPU, for `cropSplats` and the other `@margoengine/splats/data` tools.

Limits are in [docs/limits.md](../../docs/limits.md): the clouds do not follow later node moves or visibility changes.

### IES fixtures and image-based lights in glTF (`/lights`)

`EXT_lights_ies` puts measured light fixtures on a file's nodes and `EXT_lights_image_based` gives a scene its environment. Every loader reads a file that uses them, even as required extensions, and keeps them as data; `applyGLTFLightExtensions` turns them into lights, loading `@margoengine/clustered` and `@margoengine/environment` only when the file has that light.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
import {applyGLTFLightExtensions} from 'margoengine/gltf-pro/lights';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/lobby.gltf');
const lights = await applyGLTFLightExtensions(model, {exposure: 0.01, background: true});
console.log(lights.iesLights.map(({profile}) => profile.peak), lights.imageLight?.intensity);
// lights.dispose() removes all of it.
```

| Option | Default | Meaning |
| --- | --- | --- |
| `exposure` | `1` | Scales every fixture's candela: IES files are in real candela, which is far brighter than a scene's sun of 1. |
| `background` | `false` | Draws the image-based light's cube behind the scene. |
| `clustered` | one attached here | The `Clustered` to add to; the file's `KHR_lights_punctual` point and spot lights join the same list. |
| `scene` | the file's `scene`, else 0 | The scene whose image-based light to use. |
| `baseURL`, `fetch`, `signal` | where `loadGLTF` read the file, `globalThis.fetch`, none | How `.ies` and image files are read. |

Read against the two extensions' READMEs on the Khronos glTF repository as of 2026-11-06: `EXT_lights_ies` (Vendor extension, status Complete) and `EXT_lights_image_based` (Multi-Vendor extension). Neither is a draft.

- A fixture is a clustered point light with its profile resampled for its node, so it can aim anywhere, uplights included. The beam runs down the node's -Z. `multiplier` and `color` scale it as the extension says; `color` clamps to 0 to 1.
- `.ies` files read through `parseIES`: types B and C, as the extension requires. Type A, which it leaves optional, is refused.
- A cube face reads as the sRGB decode of rgb / alpha with its rows swapped, which is how the one real file reads. `Environment` prefilters its own mips from mip 0, so the file's lower mips are not read, and its own irradiance comes from the same cube: `irradianceCoefficients` stays in `lights.imageLight` as data.
- `gltfIESLights(model)` and `gltfImageLight(model)` return the data without a GPU; `orientIES` and `rotateCube` are the steps between.

Limits are in [docs/limits.md](../../docs/limits.md): lights stay where their nodes were when applied, and at most 16 fixtures differ in profile or aim.

### Rigid bodies in glTF (`/physics`, draft)

`KHR_physics_rigid_bodies` carries colliders, mass, joints and trigger volumes on a file's nodes, and `KHR_implicit_shapes` its boxes, spheres, cylinders, capsules and planes. Every loader reads a file that uses them, even as required extensions, and keeps them as data; `applyGLTFPhysics` builds them in `@margoengine/physics`, which it loads on first use, so authored physics survives export.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
import {applyGLTFPhysics} from 'margoengine/gltf-pro/physics';
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/door.gltf');
const world = await applyGLTFPhysics(model, {rapier: RAPIER});
world.onTrigger(({entered, nodeIndex, motionNodeIndex}) => console.log(entered, nodeIndex, motionNodeIndex));
console.log(world.bodies.size, world.joints.size, world.notes);
// world.dispose() removes all of it.
```

| Option | Default | Meaning |
| --- | --- | --- |
| `physics` | one attached here | The `Physics` world to add to. |
| `rapier` | none | The initialized Rapier module, for a world made here. Pass this or `physics`. |

Read against pull request 2424 (`KHR_physics_rigid_bodies`, status Draft) and pull request 2370 (`KHR_implicit_shapes`, status Release Candidate) on the Khronos glTF repository as of 2026-11-06. Both can still change.

- A node with a `motion` is a body that moves it, with the colliders of its descendants on it; a descendant with its own `motion` is its own body. A collider with no `motion` above it is fixed. A `mass` or `inertiaDiagonal` of 0 is infinite, as the draft says, and values the file leaves out come from the colliders.
- A node the file animates is kinematic and follows its animation, its scale included. `KHR_animation_pointer` channels on joint drives play on the world's clock from when `applyGLTFPhysics` ran, looping.
- A joint is a `generic` joint of `@margoengine/physics` between the two attachment frames. Limits and drives are measured from the joint node to `connectedNode`, so a drive with a target of 0.7 puts the connected node at +0.7 in the joint node's frame. A body on a joint with a drive never sleeps, because a slow body would stop short of its target.
- Collision filters compare whole filters pair by pair, each side having to let the other in.
- `geometry.node` reads that node's mesh and its children's, and `geometry.mesh`, which the extension's own sample files write in place of `node`, reads that mesh.
- `world.bodyOf(node)` finds the body that moves a node. `world.setPointer(pointer, value)` writes a joint drive's `maxForce`, `positionTarget`, `velocityTarget`, `stiffness` or `damping`, or a motion's `linearVelocity`, `angularVelocity` or `gravityFactor`, and returns false for anything else.
- `world.notes` lists what this file asks for that the world holds only approximately, by node. Empty means the file is represented as written.

Limits are in [docs/limits.md](../../docs/limits.md): Rapier's order of combine rules differs from the draft's, soft limits are held hard, ranges on several axes are boxes, finite planes are thin boxes, and a file can have 15 distinct collision filters.

### Texture mip streaming (`textures` of `/progressive`)

KTX 2.0 keeps the smallest mip first, so a texture can start from a small read of the head of its file. With `textures` set, `loadGLTFProgressive` opens each KTX2 image from those smallest levels and loads finer ones only as the texture's size on screen calls for them, inside a memory budget. Levels nothing needs leave when the budget runs out. It reuses `KTX2Streamer` of `@margoengine/decoders/ktx2-stream`, loaded only with this option.

```ts
import {createStage} from 'margoengine';
import {loadGLTFProgressive} from 'margoengine/gltf-pro/progressive';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const load = loadGLTFProgressive(stage.engine, '/city.gltf', {textures: {budgetBytes: 128 * 1024 * 1024}});
const model = await load.complete;
const textures = await load.textures;
console.log(model.primitives.length, textures?.usedBytes, textures?.textures);
```

| Option of `textures` (or `true`) | Default | Meaning |
| --- | --- | --- |
| `budgetBytes` | 256 MiB | Most GPU memory the load's textures may hold. A stream always keeps its coarsest levels, whatever the budget. Change it later through `load.textures`. |
| `concurrency` | `2` | Levels loading at once. |
| `headBytes` | 64 KiB | Bytes of an image's first Range read. |
| `decoder`, `hdrDecoder` | made on first use | Level decoders, as `KTX2Streamer`. |
| `onError` | `console.error` | Called when a finer level fails; the texture keeps the levels it has. |

`load.textures` is a promise of the live stream: `usedBytes`, `budgetBytes` (settable), `textures` (each one's size, finest level held, level count and size on screen) and `update()`. It runs by itself about five times a second for as long as the model lives; disposing the model frees it.

A texture's size on screen is the square root of its primitive's surface area over its UV area, which is the length one whole texture covers, times the pixels one world unit covers at the nearest point of the primitive's bounding sphere, on the nearest camera that sees it. Tiling, atlases and `KHR_texture_transform` scale need no special case. An image inside a GLB or a `.bin` streams too, by Range reads at its offset, and those bytes stay out of the buffers; on a server without Range the file comes once and the texture streams from memory. A file `loadGLTFProgressive` takes whole (Draco, meshopt, or a `fetch` option) still streams its KTX2 images. `complete` means every primitive is loaded and every texture is drawing from at least its coarsest levels.

PNG, JPEG, WebP and AVIF files hold no mips, so they load whole, and a KTX2 file stored with one level has nothing to stream. `model.uploadImage` refuses a streamed image, and a replica on another device refuses a streamed model. Off WebGPU the option has no effect. See `docs/limits.md`.

### Optional material extension slot

Attach a `MaterialExtension` to `primitive.extension`, or to the shared
`primitive.material.extension`, after `parseGLTF` or `loadGLTF` returns. The
primitive slot takes precedence. No material package is imported or discovered
by the loader. `parseGLTF` stays synchronous; `loadGLTF` retains its existing
Promise-based loading API.

```ts
import {type MaterialExtension, type PBRModel} from 'margoengine/gltf-pro';
declare const model: PBRModel;
const tint: MaterialExtension = {
  factors: new Float32Array([1, 0.5, 0.25, 1]),
  wgsl: 's.base *= materialFactors[0];'
};
model.primitives[0].extension = tint;
```

Bind groups are permanently allocated as follows: group 0 is the original
400-byte frame buffer, group 1 is the original five texture/sampler pairs,
group 2 is lighting and local material shading, and **group 3 is the optional material extension**.
Unextended primitives use exactly the original shader, pipeline descriptors,
uniform uploads and bindings. Extension GPU resources are created lazily during
`draw()`, including when an extension is attached after model setup.

`factors` is an optional, nonempty `Float32Array` of finite values whose length
is a multiple of four. It becomes `materialFactors: array<vec4f, N>` at group 3,
binding 0. Mutations upload on the next visible draw; changing its length
reallocates only the secondary buffer. `textures` optionally supplies
`{view: GPUTextureView, sampler?: GPUSampler}` entries for filterable 2D textures.
Entry N exposes `materialTextureN` at binding `1 + 2*N` and, if supplied,
`materialSamplerN` at binding `2 + 2*N`. Missing factors, textures and samplers
allocate no corresponding resources. Texture views and samplers stay owned by
the caller; replace them after device restoration before drawing again.

`wgsl` contains statements inserted immediately after `surface(i, front)` in
beauty, g-buffer and ambient fragment entry points. It can mutate `s: Surface`
and read `i`, `front`, the original frame `f`, and the generated extension
resources. `declarations` optionally supplies module-scope WGSL helpers. Callers
must supply valid WGSL for all three entry points and leave bind group allocation
to the slot. Generated phony assignments retain declared resources in each
entry point's interface without sampling them. A resource-bearing extension
without lighting also binds the empty group 2 required by the pipeline layout.

`direct` optionally supplies beauty-only statements after the directional
lighting calculation. It may update `direct` before the existing lighting effects
apply, so additional lobes share directional shadow visibility. It does not run
in g-buffer or ambient entry points. Unextended shader strings stay unchanged.
A second model of the same asset can hold this model's decoded images, and then shares the GPU textures made from
them instead of uploading and mipping its own. Each image and texture goes with its last holder, in any disposal order
(`cloneModel` from `@margoengine/animation/skeleton-utils` does this for you):

```ts
import {PBRModel, loadGLTF} from 'margoengine/gltf-pro';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

const first = await loadGLTF(engine, 'robot.glb');
const second = new PBRModel(engine, first.asset, first.shareImages());
engine.use(second);
```

`shareImages()` counts the new holder at once: pass the images to `closeImages(images)` if no model ends up holding
them.

`second.adoptStaticBatches(first)`, called before `engine.use(second)`, takes `first`'s baked static batches so
`second` skips baking and the engine-wide tick baking needs. `second` must be a fresh model of the same asset in the
same local pose, and `first` must be set up and unparented. It returns false, changing nothing, when the batches do not
fit, and `second` then bakes for itself. Either way draws are right. `cloneModel` in `@margoengine/animation` calls it.

`model.compile()` compiles the model's render pipelines without blocking, so its first frame does not wait for them.
Call it once the scene's lights and effects are set: anything that changes a shader afterwards compiles on the draw as
before, so it is never needed for correctness. Start it early and await it late, so the compile overlaps other work. The
wait moves rather than disappears: `p-morph`'s first frame fell by 83 ms and its build grew by 54 to 72.

```ts
import {loadGLTF} from 'margoengine/gltf-pro';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

const model = await loadGLTF(engine, 'robot.glb');
const compiled = model.compile();
// ...build the rest of the scene...
await compiled;
```

It does nothing off WebGPU, leaves batched textureless meshes to their first draw, and rejects with the GPU's error if
a pipeline fails. Copies of a model share pipelines, so one call serves them all.

Optional material packages can borrow decoded images with `model.image(index)`;
the model retains ownership and closes them when disposed.

`output` optionally supplies beauty-only WGSL immediately before the final
return, after tone mapping/output encoding. `lighting: false` omits optional
lighting shaders and bindings for a caller-managed surface. The material package
uses these hooks for transmission while retaining the baseline factor-zero path.
`transmission` (a WGSL weight, kept in `s.tr`) scales diffuse and ambient light by
1 minus it, and `ior` (a WGSL index of refraction, kept as `s.f0`) sets the
dielectric F0 of direct and ambient light to ((ior - 1) / (ior + 1))^2 in place of
0.04, as the native physical path does; without `ior` the F0 stays 0.04.
The optional `coat` layer goes over all the surface's light, as
`KHR_materials_clearcoat` defines it: direct, local, ambient and emitted light keep
the share `keep`, the layer's `direct` light adds on top with the same shadow
visibility, and `(1 - keep) * margoCoatAmbient(s, v)` adds its ambient light. `normal`
and `roughness` land in `s.cn` and `s.cr`, which an environment's `coat` hook reads.
`direct` hooks of lighting effects must scale the light they wrap, since a coated
shader evaluates them once on `vec3f(1)` and multiplies every sun lobe by the result.
Native physical materials do the same for their clearcoat and sheen lobes, so a
shadow removes those highlights with the base's; fragments where nothing is lit
stay zero, so `Shadows` still skips them. An effect with only a raw `shader` edit of
`direct+ambient(s)` reaches the base's light and misses these lobes, so a shadowing
effect uses the `direct` hook. All four fields are WGSL expressions
evaluated after `wgsl`:

```ts
import {type MaterialExtension} from 'margoengine/gltf-pro';

const varnish: MaterialExtension = {
  wgsl: 'let varnishKeep=0.9;',
  coat: {keep: 'varnishKeep', direct: 'vec3f(0)', normal: 's.n', roughness: '0.1'},
};
```

The optional `ambient` statements can mutate `materialAmbient` after hemisphere
lighting in beauty and ambient-only passes. They are applied after lighting
effects have matched the standard PBR source. Materials uses this hook for sheen,
specular color and thin-film reflection; primitives without a hook retain their
original shader and bindings.
`PBRModel.beginOpaquePass(context)` defers blended beauty draws across models;
`PBRModel.endOpaquePass(context)` flushes them after a caller-owned scene copy,
and `cancelOpaquePass(context)` releases an interrupted phase. Calls to `draw()`
with an explicit `opaque` or `blend` phase participate in the same deferral:
opaque primitives draw immediately and blended primitives flush once per model.
Calls outside that optional phase retain their existing order and bindings.
An extension with `afterOpaque: true` (materials transmission sets it) also flushes with the blended draws, after the
opaque capture, but keeps its authored alpha mode, blending and depth writes; such primitives cast no opaque shadows.

A package whose frame-graph pass draws one run and nothing else can declare `joins` on its pass: the run's render pass then takes core's clear and resolves the frame ([core README](../core/README.md#viewport-and-scissor-per-core-draw)), one render pass for the whole frame.

A package that draws many models itself passes a `PBRDrawRun` as the last argument of `draw()`. Every `draw()` of the
run continues one render pass instead of beginning its own, which saves a store and a reload of the multisampled colour
and depth per model (10,000 meshes of `@margoengine/materials` cost 168 ms of CPU a frame with a pass each). Blended
draws continue it too; a blended primitive drawn without a run ends the pass around itself. Within a run:

- draws of one material record derive its shader, pipeline and lighting bind group once per frame, not once per draw;
- the run sets a pipeline, bind group or buffer only when it changes;
- opaque draws that differ only in their node matrix (same material record, same geometry arrays, no instances,
  deformation, material extension, transmission or wireframe) draw as one instanced draw at `run.end()` or before the
  run's next other draw, with their world matrices as instance rows; a moved mesh uploads its own 96-byte row. Opaque
  draws may therefore reorder between such batches (as engines sort opaque draws by material); each batch keeps its
  meshes in draw order, and a mesh alone draws exactly as without a run.

Every draw's camera, light and target rows come from one 192-byte view block that the draws of a view share, so a
moving camera uploads 192 bytes, not every draw's uniform. Call `run.end()` after the last draw; a run can carry the
next frame's draws after that:

```ts
import {PBRDrawRun, type PBRModel} from '@margoengine/gltf-pro';
export function drawAll(models: PBRModel[], c: Parameters<PBRModel['draw']>[0]) {
  const run = new PBRDrawRun();
  try {
    for (const model of models) model.draw(c, 'beauty', c.color, c.depth, 'all', undefined, run);
  } finally {
    run.end();
  }
}
```

Full generated WGSL, including the injection and resource layout, distinguishes
pipeline cache entries. Even an empty extension cannot share the baseline
pipeline. Removing an extension releases its secondary buffer on the next
visible draw and restores the baseline path. Model disposal and device
restoration release all owned secondary buffers. Extensions that require
blending use the existing `material.settings[0] = 2` path. This slot adds no new
material lobes, passes or attributes.

Run `node scripts/material-extension-tests.js` for the material slot's WebGPU
checks, also included in `npm run modern:test:extensions`.

Limits: triangle primitives; at most eight skin influences in the animation package; UV sets 0 to 3. Unknown required extensions still reject. Ambient fill uses fixed sky/ground colors; image-based lighting is a separate optional package. Bounds describe the bind pose with current node transforms; GPU picking requires the optional selection package.

`npm run modern:test:gltf-parity` checks texture-coordinate and alpha-shadow pixel
parity, KTX2 mip upload and worker disposal in a production Vite build, complete
Khronos assets, and eight-influence character deformation against a CPU reference.
These checks are also part of `npm run modern:test:extensions`.

The demo at `/examples/flight-helmet.html` loads the [Khronos FlightHelmet](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/FlightHelmet) (CC0 1.0). Asset credits are in [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md).
