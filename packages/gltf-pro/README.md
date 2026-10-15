# Margo Engine glTF Pro

Use `import {GLTFAsset} from '@margoengine/gltf-pro/asset'` for accessor decoding
without loading PBR rendering or its shaders. The root export retains the same
constructor; `GLTFDocument` is available as a type from either entry.

Optional WebGPU glTF 2.0 metallic-roughness rendering, separate from the frozen core and stage. The public npm name follows this repository's scope: `@margoengine/gltf-pro`.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from '@margoengine/gltf-pro';
const stage = await createStage('#viewport', {backend:'webgpu'});
const model = await loadGLTF(stage.engine, '/DamagedHelmet.glb');
const b = model.bounds;
stage.engine.camera.fitToBoundingBox([b[0],b[1],b[2]], [b[3],b[4],b[5]]);
// Call model.dispose() when unloading the model, or stage.dispose() on unmount.
```

Supports base color/alpha, metallic-roughness (G/B), normal maps, occlusion (R), emissive, vertex colors, UV sets 0/1, tangents or derivative tangent frames, alpha masking/blending, double-sided materials, GLB/external buffers/images, normalized and sparse accessors. GGX, Smith, and Schlick implement analytical direct lighting with hemispherical ambient fill. Canvas output uses Three.js-compatible ACES Filmic tone mapping and sRGB encoding; HDR captures remain linear. Color/emissive textures decode sRGB; other maps remain linear. Images have generated mip chains and honor glTF filtering and wrapping.

`parsePreparedPBR(engine, document, geometry, images)` accepts a static glTF-style scene/material document and per-mesh arrays of `PreparedGeometry` (`vertices: Float32Array`, `indices: Uint32Array`). Vertices use the existing 80-byte layout: position4, normal4, tangent4, UV0+UV1, color4. Arrays are validated and retained without repacking; keep them immutable until destruction. This path has no accessors, skins or animations and is used by the separate `@margoengine/blender` loader. Existing glTF loading and animation APIs are unchanged.

Attach animation with the separate animation package. Register this model with `ssao.add(model)` to include its mapped normals and ambient lighting in SSAO. When a lighting effect replaces the ambient light through the `ambient` hook (environment's `EnvironmentLighting`), the SSAO ambient replay draws the lit fragment returning that light (`margoAmbient`, zero for unlit materials) with the effects' group-2 bindings; otherwise it draws `ambientFragment` as before. Neither extension is imported by this package. Disposal and device restoration retain CPU asset blueprints.

Register with `shadows.add(model)` and `clustered.add(model)` for optional directional shadows and local PBR lights, including the current skinned vertex buffer. `addLighting()` takes such effects without importing their packages (see "Lighting hooks").

### Pipeline constants

The PBR shader declares two `override` constants, `margoFaceTest` and `margoAlphaTest` (both default `true`). gltf-pro's own pipelines set `margoFaceTest` to 0 (back faces are already culled by the pipeline, so the test never discards) and `margoAlphaTest` to 1 only for `MASK` materials; the alpha mode is part of the pipeline key. Any `discard` in a fragment shader costs early depth testing: on a full-screen DamagedHelmet (Arc 140V) GPU time fell from 0.85 to 0.52 ms, with identical pixels for every material kind on the real GPU (`examples/package-benchmarks/pipeline-toggles/pixproof.mjs`). Other code that compiles this shader keeps the defaults.

### Lighting hooks

A `LightingEffect` (`addLighting(effect)`) lights both PBR variants (standard and physical) through declared hook points instead of searching this package's WGSL. `effect.pbr(2)` returns a `PBRLighting` (contract version 1; return `undefined` while not ready, and the same object on steady frames, since composition is cached per object), and `effect.bindings()` its group-2 entries:

- `declarations`: module-scope WGSL put before the shader (bindings in group 2, helper functions).
- `direct(expr)`: wraps the directional light term (shadows: `shadowLit(direct,i.position,s.n)`).
- `light`: a `vec3f` added before the directional term (clustered local lights).
- `ambient`: a `vec3f` replacing the hemisphere ambient (environment IBL; at most one effect). It is declared as `let margoAmbient=`, and SSAO's ambient replay returns it.
- `output(expr)`: wraps the display colour after tone mapping, before sRGB encoding (fog).

In scope: `i` (vertex output: position, normal, uv, color), `s` (Surface: base, n, roughness, metal, occlusion, emissive), `v` (to the eye) and `f` (frame uniforms). Effects compose in any order to the same shader body. `tests/extensions.test.js` checks each hook point occurs exactly once in both variants; shadows, clustered and environment test their contributions, and `examples/package-benchmarks/proofs/gltf-pro-lighting-hooks.proof.js` shows the GPU calls equal the text patches they replaced (they matched until 5c moved the IBL BRDF LUT into a storage buffer; `binding-limit.proof.js` maps that change back, and the default run now checks 4,556 calls byte-identical against `f8a36ca`). Effects without `pbr` (materials, shader nodes, LOD imposter baking) still patch the text through `shader(source, 2)`; the anchors they use (the map `textureSample` calls, the beauty fragment head up to `let s=surface(i,front);`, `if(margoFaceTest&&!facing&&f.settings.z<0.5){discard;}`, the vertex `let p=f.model*...` line and `struct Out`) are kept and listed in `tests/shader-contracts.test.js`. `shadowPrimitives` exposes current opaque/masked GPU geometry to depth consumers; blended materials are omitted.

Pipeline state hook: set `primitive.material.renderState` (type `PBRRenderState`) to override the beauty pipeline's
`blend` (a `GPUBlendState`, or `null` for no blending), `depthWrite` and `depthCompare` for every primitive using that
material; unset fields keep the defaults above. It is part of the pipeline cache key (replace the object rather than
mutating it), the g-buffer and ambient passes ignore it, and draw order and pass splitting still follow `alphaMode`.
Without it the pipelines are unchanged. `@margoengine/materials` uses it for `blending`, `depthWrite` and `depthTest`.

### Transparency hook

`model.setTransparency(hook)` (type `PBRTransparency`, contract version 1; returns a remover) hands the model's BLEND
primitives to an order-independent transparency pass such as `@margoengine/oit`. While a hook is set, BLEND primitives
without transmission and without a `renderState` leave the beauty pass (transmission tints and custom blending keep the
sorted path), and `model.draw(c, 'transparent', ...)` draws only them, into `hook.begin()`'s pass with `hook.targets`,
depth tested (`greater-equal`) and not written. Their shader is the lit beauty shader with the fragment head
`@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {` renamed to
`fn margoShade(i:Out,front:bool)->vec4f {` and an entry point `transparent` returning
`margoTransparent(margoShade(i,front),i)`; `hook.declarations(2)` supplies `struct MargoTransparent`, that function and its
group-2 bindings (after the lighting effects' entries, from `hook.bindings()`). Lighting effects and text patches
(materials, shader nodes) compose as in the beauty pass, and the pass adds no textures. Without a hook nothing changes:
`examples/package-benchmarks/proofs/oit-detached.proof.js` records identical GPU calls to the build before the hook.

### Texture bindings

WebGPU guarantees 16 sampled textures and 16 samplers per shader stage (the default and the minimum every adapter
supports, phones included), and Margo's device asks for no more. Each lighting effect and material patch adds its
bindings to the one fragment stage. Sampled textures (samplers) in the beauty and SSAO ambient-replay fragment:

| Material | Alone | + shadows | + IBL | + LocalShadows | + shadows, IBL, LocalShadows |
| --- | --- | --- | --- | --- | --- |
| gltf-pro standard | 5 (5) | 6 (6) | 6 (6) | 6 (6) | 8 (8) |
| gltf-pro physical (clearcoat, transmission, sheen, specular, ior, volume) | 13 (13) | 14 (14) | 14 (14) | 14 (14) | **16 (16)** |
| materials `standard`, `basic`, `normal` | 10 (10) | 11 (11) | 11 (11) | 11 (11) | 13 (13) |
| materials `matcap` | 11 (11) | 12 (12) | 12 (12) | 12 (12) | 14 (14) |
| shader `NodeMaterial` with N distinct texture nodes | 10+N | 11+N | 11+N | 11+N | 13+N: over 16 from N = 4 (matcap: N = 3) |

Shadows (directional cascades) add 1 depth array + 1 comparison sampler; environment IBL 1 cube + 1 sampler (its BRDF
LUT is a storage buffer and SH irradiance a uniform); LocalShadows (`@margoengine/clustered/shadows`) 1 depth array + 1
comparison sampler. Fog, clustered lights (3 storage buffers), SSAO and LOD baking add no textures, and the G-buffer
pass binds only the material's own maps (5 or 13). Before 5c the IBL BRDF LUT was a texture, so physical + all three was
17 and failed pipeline creation. A draw whose shader declares more sampled textures or samplers than
`device.limits` allows throws a `RangeError` naming the combination, e.g. `gltf-pro: physical material + shadows +
environment:lighting + clustered + clustered:shadows + shader patch needs 17 sampled textures per shader stage; this
device allows 16`. Physical materials with every lighting package use all 16 of both, so any further texture on them
(a custom shader patch) needs a device created with raised limits.

### Instancing

Instancing is its own entry, `@margoengine/gltf-pro/instancing` (about 2.2 kB min+gzip, [entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)), so apps that never instance load none of it. `primitive.instances = new PBRInstances(capacity)` draws a primitive `count` times in one instanced draw (the counterpart of three.js `InstancedMesh`; `@margoengine/materials` `createInstancedMesh` wraps it). Instance matrices are in the primitive's node space (world = node matrix x instance matrix, as `EXT_mesh_gpu_instancing`), so for a model whose meshes sit on nodes with their own transforms, an instance matrix moves the node, not the model root. Primitives, also of different models, may share one `PBRInstances`; all primitives of a node share one when it comes from `EXT_mesh_gpu_instancing`.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from '@margoengine/gltf-pro';
import {PBRInstances, instancing} from '@margoengine/gltf-pro/instancing';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const tree = await loadGLTF(stage.engine, '/tree.glb');
const forest = new PBRInstances(2000);
for (let i = 0; i < 2000; i++) forest.setMatrixAt(i, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, Math.random() * 200, 0, Math.random() * 200, 1]);
for (const primitive of tree.primitives) primitive.instances = forest;
forest.count = 1500;                     // drawn instances (default and maximum: capacity)
// forest.data: 24 floats per instance (matrix, tint, UV scale + offset); after writing it directly: forest.needsUpdate = true

// EXT_mesh_gpu_instancing files: pass the reader like a decoder (also to parseGLTFAsync, parseGLTF and the worker loaders).
const city = await loadGLTF(stage.engine, '/instanced-city.glb', {decoders: {instancing}});
```

Without `decoders.instancing`, a file whose `extensionsRequired` lists `EXT_mesh_gpu_instancing` is rejected with `Required glTF extensions are unsupported: EXT_mesh_gpu_instancing (pass decoders.instancing from @margoengine/gltf-pro/instancing)`, the same rule as a missing Draco or KTX2 decoder. A file that only lists it in `extensionsUsed` loads with each instanced node's mesh drawn once at the node (the glTF fallback for an unsupported optional extension). `parseGLTF(engine, input, buffers, images, {instancing})` and `modelFromPrepared(engine, prepared, signal, {instancing})` take the reader as their last argument.

`setMatrixAt(i, m)` (column-major affine), `getMatrixAt(i, out?)`, `setColorAt(i, [r, g, b(, a)])` (linear, multiplies the base colour like a vertex colour), `setUVTransformAt(i, {offset, scale})` (applied to both UV sets before the material's texture transforms, e.g. a `packAtlas` region; no rotation), `count`, `needsUpdate`, `dispose()` (frees the GPU buffer; it is recreated on the next draw). Setters upload only the changed rows on the next frame. Shadows and `@margoengine/staging` contact shadows cast every instance; clustered, IBL, fog and SSAO apply through the same lighting hooks (the instanced shader changes only the vertex stage); `model.bounds` covers every instance; bvh's `Raycaster` and selection's `Picking` report `instanceId`, and a selected model outlines every instance. A mirrored instance (negative determinant) turns off face culling for that primitive and discards back faces in the shader instead. The non-instanced draw makes the same GPU calls as before instancing (`gltf-pro-lighting-hooks.proof.js` and `materials-uv-transform.proof.js`, run against `114130c` when instancing became opt-in; their default refs are now later commits).

Limits: no per-instance frustum culling (all `count` instances are drawn); transparent instances are not sorted among themselves; TAA gives instances camera motion only (static instances are exact, moving ones may ghost); instances are not seen by LOD imposter baking, and selection outlines all instances of a selected primitive rather than one; `ScatterInstances` keeps its own constant-colour path. Shadow caching (`shadows.add(model, {static: true})`) and static contact shadows do not see instance edits until invalidated.

## Parsing in a worker

`@margoengine/gltf-pro/worker` moves everything except GPU uploads off the main thread: download, JSON, accessor decoding (geometry, skins, morph targets, animation samplers), vertex packing and image decoding run in a worker; the buffers and ImageBitmaps are transferred back (no copies) and the main thread only builds the `PBRModel` and uploads it.

```ts
import {createStage} from 'margoengine';
import {loadGLTFInWorker, parseGLTFInWorker} from '@margoengine/gltf-pro/worker';
const stage = await createStage('#viewport', {backend:'webgpu'});
const model = await loadGLTFInWorker(stage.engine, '/DamagedHelmet.glb'); // same PBRModel as loadGLTF
const bytes = await (await fetch('/scene.glb')).arrayBuffer();
const dropped = await parseGLTFInWorker(stage.engine, bytes); // bytes move to the worker and are detached here
```

The result equals `loadGLTF` / `parseGLTFAsync` byte for byte (`tests/worker.test.js` compares document, buffers, every accessor, packed vertices, materials, images and node transforms). The functions run on the calling thread instead when `Worker` is unavailable (SSR, Node) or Draco, meshopt or KTX2 `decoders` are passed (Draco and KTX2 already decode in their own workers); `decoders.instancing` stays on the worker path (the worker decodes the `EXT_mesh_gpu_instancing` accessors, the main thread composes the matrices). The worker script, `dist/workers/gltf.js` (about 5.6 kB min+gzip, same record), is started with `new URL('./workers/gltf.js', import.meta.url)`, which Vite and webpack copy as an asset: apps that do not import `/worker` ship none of it. One worker per load, terminated afterwards. `modelFromPrepared(engine, prepared)` and `@margoengine/gltf-pro/prepare` (`prepareGLTF`, `prepareAsset`) let other loaders' workers (fbx, usdz) reuse the step. Main-thread blocking measured in a real browser: `examples/package-benchmarks/workers/` (HANDOFF 1f.j).

## Extensions and compressed files

Supported glTF extensions: `KHR_mesh_quantization`, `KHR_texture_transform`, `KHR_materials_emissive_strength`, `KHR_materials_unlit`, `KHR_lights_punctual`, `KHR_materials_clearcoat`, `KHR_materials_transmission`, `KHR_materials_ior`, `KHR_materials_volume`, `KHR_materials_sheen`, `KHR_materials_specular`, `EXT_texture_webp`, `EXT_texture_avif`, plus `EXT_mesh_gpu_instancing` (`TRANSLATION`, `ROTATION` including normalized integers, `SCALE`; the node's primitives get one `PBRInstances`, see "Instancing"), `KHR_draco_mesh_compression`, `EXT_meshopt_compression` (and `KHR_meshopt_compression`) and `KHR_texture_basisu` when you pass the matching decoder (`instancing` from `@margoengine/gltf-pro/instancing` for the first). A file is rejected only when its `extensionsRequired` lists something still unsupported; the error names each one and the decoder it needs.

This package does not import `@margoengine/decoders`. Pass decoders in, so files without compression pay nothing:

```ts
import {createStage} from 'margoengine';
import {engineRuntime} from '@margoengine/core/extension';
import {loadGLTF, parseGLTFAsync} from '@margoengine/gltf-pro';
import {DracoDecoder, KTX2Decoder, MeshoptDecoder} from '@margoengine/decoders';

declare const file: File; // e.g. from a file input or a drop
const stage = await createStage('#viewport', {backend: 'webgpu'});
const device = engineRuntime(stage.engine).gpu ?? undefined; // lets KTX2 pick BC7/ASTC/ETC2 when enabled
const decoders = {draco: new DracoDecoder(), meshopt: MeshoptDecoder, ktx2: new KTX2Decoder({device})};
const model = await loadGLTF(stage.engine, '/gltfpack-output.glb', {decoders});
const dropped = await parseGLTFAsync(stage.engine, await file.arrayBuffer(), {decoders}); // in-memory GLB/JSON
// decoders.draco.dispose(); decoders.ktx2.dispose(); when no more loads are expected.
```

Any object with the same shape works (`GLTFDecoderHooks`): `draco.decode(bytes, {attributeIds, componentTypes, signal})` resolving to `{positions, normals?, uvs?, colors?, indices?, attributes?}`, `meshopt.decodeGltfBuffer(target, count, stride, source, mode, filter)` (three.js's `MeshoptDecoder` fits once its `ready` promise resolves), and `ktx2.transcode(bytes, {signal})` resolving to `{width, height, format, mipmaps: [{data, width, height}]}` in rgba8, BC7, ASTC 4x4 or ETC2 RGBA8. The synchronous `parseGLTF` takes only the synchronous `instancing` reader (its fifth argument). Without a ktx2 decoder, KTX2 images are skipped and a texture's PNG/JPEG fallback `source` is used.

`model.lights` and `model.cameras` expose `KHR_lights_punctual` lights and glTF cameras as data, each with its scene `node`. `model.clusteredLights()` returns the point and spot lights in world space for `clustered.setLights(...)`; an unbounded light gets the range where intensity/d² falls to 1/256. Directional lights are left to the engine's own light.

Materials using clearcoat, transmission, IOR, volume, sheen or specular compile a separate shader variant with eight more texture slots (clearcoat, clearcoat roughness, clearcoat normal, transmission, sheen color, sheen roughness, specular, specular color), so plain materials keep the original shader and bindings. Approximations, by design:

- Transmission does not refract. A transmissive surface draws in the blended queue with its diffuse reduced by the transmission factor and texture, and the background shows through multiplied by one per-material tint: base color × transmission × volume attenuation (`attenuationColor` raised to `thicknessFactor / attenuationDistance`). `transmissionTexture` therefore varies the surface but not the background; `thicknessTexture` is ignored.
- Sheen (Charlie distribution) and clearcoat (GGX on its own normal, F0 0.04) respond to the key light and the hemisphere fill. Image-based lighting patches and clustered lights light the base layer only.
- IOR and `KHR_materials_specular` set the dielectric F0 as three.js does: `min(((ior-1)/(ior+1))² × specularColor, 1) × specular`.

Limits: triangles only; four skin influences in the animation package; texture coordinate sets beyond 1 are rejected. Ambient fill uses fixed sky/ground colors unless `@margoengine/environment`'s `EnvironmentLighting` is applied to the model (`ibl.add(model)`), which adds image-based lighting. Bounds describe the original mesh. Core `engine.pick` returns models only when `@margoengine/selection`'s `Picking` is attached; bvh's `Raycaster` hits them on the CPU.

The demo at `/examples/damaged-helmet.html` downloads the [Khronos Damaged Helmet](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DamagedHelmet). Its credits/licenses remain with the original asset.
