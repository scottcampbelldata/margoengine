# Margo Engine glTF Pro

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
without advancing animation time. Snapshots include world matrices, indices and
material sides captured with the query. Restoration, disposal or replacement of
an in-flight deformation output invalidates the result and releases staging
buffers. Caller-provided deformation buffers need `COPY_SRC` for CPU snapshots.

Use `import {GLTFAsset} from '@margoengine/gltf-pro/asset'` for accessor decoding
without loading PBR rendering or its shaders. The root export retains the same
constructor; `GLTFDocument` is available as a type from either entry.

Optional WebGPU glTF 2.0 metallic-roughness rendering, separate from the frozen core and stage. The public npm name follows this repository's scope: `@margoengine/gltf-pro`.

The verified core + stage bundle remains **19,999 bytes gzip**; CI rejects 20,000 bytes and above. Optional loaders, decoder code, workers and Wasm stay outside that measurement.

```ts
import {createStage} from 'margoengine';
import {loadGLTF, type MaterialExtension} from '@margoengine/gltf-pro';
const stage = await createStage('#viewport', {backend:'webgpu'});
const model = await loadGLTF(stage.engine, '/DamagedHelmet.glb');
const b = model.bounds;
stage.engine.camera.fitToBoundingBox([b[0],b[1],b[2]], [b[3],b[4],b[5]]);
// Call model.destroy() when unloading the model, or stage.dispose() on unmount.
```

Supports base color/alpha, metallic-roughness (G/B), normal maps, occlusion (R), emissive, vertex colors, UV sets 0/1, tangents or derivative tangent frames, alpha masking/blending, double-sided materials, GLB/external buffers/images, normalized and sparse accessors. GGX, Smith, and Schlick implement analytical direct lighting with hemispherical ambient fill. Canvas output uses Three.js-compatible ACES Filmic tone mapping and sRGB encoding; HDR captures remain linear. Color/emissive textures decode sRGB; other maps remain linear. Images have generated mip chains and honor glTF filtering and wrapping.

`loadGLTF` automatically decodes `KHR_draco_mesh_compression` primitives and
`EXT_meshopt_compression` buffer views and `KHR_texture_basisu` textures using `@margoengine/decoders`, installed as
a dependency. Draco workers and Wasm start only when compressed primitives are
encountered and are released after decoding, including on failure or cancellation.
Meshopt decoding is synchronous and cached per buffer view, including views used
by skin, morph and animation accessors. Unknown required extensions still fail.

For in-memory JSON or GLB bytes, use
`await parseGLTFAsync(engine, input, buffers, images, {signal, draco, ktx2})`.
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
`parseGLTFAsync` decodes embedded/data-URI KTX2; external images use `loadGLTF`.
Synchronous `parseGLTF` also accepts already decoded `GLTFImage` blueprints.

`KHR_texture_transform` supports offset, rotation, scale, and the overriding UV set
on all five PBR maps. UV0 and UV1 already share the fixed 80-byte vertex layout.
Nonidentity transforms append affine rows to group 3 alongside any caller material
factors. Identity transforms and ordinary UV0 materials retain the exact original
shader, 400-byte frame, and groups 0/1. Normal maps derive their tangent frame from
transformed or secondary UVs; alpha-masked directional shadows use the same mapping.
Optional material maps support the same transform through `materials.install()`.
`textureCoordinates(info)` exposes the validated UV selection and packed affine rows;
caller-owned clearcoat/transmission textures accept a glTF-style `transform` option.

The loader passes declared vertex/index counts, accessor widths and the remaining
256 MiB decoded-data budget into Draco. The default decoder rejects oversized
actual geometry before allocating output arrays, including topology without an
index accessor. It still needs to decode internal Wasm geometry before reading
those counts. Custom `draco.decode` hooks should honor the supplied `limits`;
the loader also validates returned data before constructing GPU resources.

`parsePreparedPBR(engine, document, geometry, images)` accepts a static glTF-style scene/material document and per-mesh arrays of `PreparedGeometry` (`vertices: Float32Array`, `indices: Uint32Array`). Vertices use the existing 80-byte layout: position4, normal4, tangent4, UV0+UV1, color4. Arrays are validated and retained without repacking; keep them immutable until destruction. This path has no accessors, skins or animations and is used by the separate `@margoengine/blender` loader. Existing glTF loading and animation APIs are unchanged.

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
import {getSceneBounds, fitScene, gatherSceneBuffers} from '@margoengine/gltf-pro/scene';

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

Register with `shadows.add(model)` and `clustered.add(model)` for optional directional shadows and local PBR lights, including the current skinned vertex buffer. `addLighting()` accepts an optional shader/binding hook without importing these packages. `shadowPrimitives` exposes current opaque/masked GPU geometry to depth consumers; blended materials are omitted.

### Optional material extension slot

Attach a `MaterialExtension` to `primitive.extension`, or to the shared
`primitive.material.extension`, after `parseGLTF` or `loadGLTF` returns. The
primitive slot takes precedence. No material package is imported or discovered
by the loader. `parseGLTF` stays synchronous; `loadGLTF` retains its existing
Promise-based loading API.

```ts
const tint: MaterialExtension = {
  factors: new Float32Array([1, 0.5, 0.25, 1]),
  wgsl: 's.base *= materialFactors[0];'
};
model.primitives[0].extension = tint;
```

Bind groups are permanently allocated as follows: group 0 is the original
400-byte frame buffer, group 1 is the original five texture/sampler pairs,
group 2 is lighting, and **group 3 is the optional material extension**.
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
Optional material packages can borrow decoded images with `model.image(index)`;
the model retains ownership and closes them when disposed.

`output` optionally supplies beauty-only WGSL immediately before the final
return, after tone mapping/output encoding. `lighting: false` omits optional
lighting shaders and bindings for a caller-managed surface. The material package
uses these hooks for transmission while retaining the baseline factor-zero path.
The optional `ambient` statements can mutate `materialAmbient` after hemisphere
lighting in beauty and ambient-only passes. They are applied after lighting
effects have matched the standard PBR source. Materials uses this hook for sheen,
specular color and thin-film reflection; primitives without a hook retain their
original shader and bindings.
`PBRModel.beginOpaquePass(context)` defers blended beauty draws across models;
`PBRModel.endOpaquePass(context)` flushes them after a caller-owned scene copy,
and `cancelOpaquePass(context)` releases an interrupted phase. Calls to `draw()`
outside that optional phase retain their existing order and bindings.

Full generated WGSL, including the injection and resource layout, distinguishes
pipeline cache entries. Even an empty extension cannot share the baseline
pipeline. Removing an extension releases its secondary buffer on the next
visible draw and restores the baseline path. Model disposal and device
restoration release all owned secondary buffers. Extensions that require
blending use the existing `material.settings[0] = 2` path. This slot adds no new
material lobes, passes or attributes.

Run `node scripts/material-extension-tests.js` for the material slot's WebGPU
checks, also included in `npm run modern:test:extensions`.

Limits: triangle primitives; at most eight skin influences in the animation package; UV sets 0/1. Unknown required extensions still reject. Ambient fill uses fixed sky/ground colors; image-based lighting is a separate optional package. Bounds describe the bind pose with current node transforms; GPU picking requires the optional selection package.

`npm run modern:test:gltf-parity` checks texture-coordinate and alpha-shadow pixel
parity, KTX2 mip upload and worker disposal in a production Vite build, complete
Khronos assets, and eight-influence character deformation against a CPU reference.
These checks are also part of `npm run modern:test:extensions`.

The demo at `/examples/damaged-helmet.html` downloads the [Khronos Damaged Helmet](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DamagedHelmet). Its credits/licenses remain with the original asset.
