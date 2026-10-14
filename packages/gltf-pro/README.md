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
// Call model.destroy() when unloading the model, or stage.dispose() on unmount.
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

In scope: `i` (vertex output: position, normal, uv, color), `s` (Surface: base, n, roughness, metal, occlusion, emissive), `v` (to the eye) and `f` (frame uniforms). Effects compose in any order to the same shader body. `tests/extensions.test.js` checks each hook point occurs exactly once in both variants; shadows, clustered and environment test their contributions, and `examples/package-benchmarks/proofs/gltf-pro-lighting-hooks.proof.js` shows the GPU calls equal the text patches they replaced. Effects without `pbr` (materials, shader nodes, LOD imposter baking) still patch the text through `shader(source, 2)`; the anchors they use (the map `textureSample` calls, the beauty fragment head up to `let s=surface(i,front);`, `if(margoFaceTest&&!facing&&f.settings.z<0.5){discard;}`, the vertex `let p=f.model*...` line and `struct Out`) are kept and listed in `tests/shader-contracts.test.js`. `shadowPrimitives` exposes current opaque/masked GPU geometry to depth consumers; blended materials are omitted.

Pipeline state hook: set `primitive.material.renderState` (type `PBRRenderState`) to override the beauty pipeline's
`blend` (a `GPUBlendState`, or `null` for no blending), `depthWrite` and `depthCompare` for every primitive using that
material; unset fields keep the defaults above. It is part of the pipeline cache key (replace the object rather than
mutating it), the g-buffer and ambient passes ignore it, and draw order and pass splitting still follow `alphaMode`.
Without it the pipelines are unchanged. `@margoengine/materials` uses it for `blending`, `depthWrite` and `depthTest`.

### Instancing

`primitive.instances = new PBRInstances(capacity)` draws a primitive `count` times in one instanced draw (the counterpart of three.js `InstancedMesh`; `@margoengine/materials` `createInstancedMesh` wraps it). Instance matrices are in the primitive's node space (world = node matrix x instance matrix, as `EXT_mesh_gpu_instancing`), so for a model whose meshes sit on nodes with their own transforms, an instance matrix moves the node, not the model root. Primitives, also of different models, may share one `PBRInstances`; all primitives of a node share one when it comes from `EXT_mesh_gpu_instancing`.

```ts
import {createStage} from 'margoengine';
import {loadGLTF, PBRInstances} from '@margoengine/gltf-pro';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const tree = await loadGLTF(stage.engine, '/tree.glb');
const forest = new PBRInstances(2000);
for (let i = 0; i < 2000; i++) forest.setMatrixAt(i, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, Math.random() * 200, 0, Math.random() * 200, 1]);
for (const primitive of tree.primitives) primitive.instances = forest;
forest.count = 1500;                     // drawn instances (default and maximum: capacity)
// forest.data: 24 floats per instance (matrix, tint, UV scale + offset); after writing it directly: forest.needsUpdate = true
```

`setMatrixAt(i, m)` (column-major affine), `getMatrixAt(i, out?)`, `setColorAt(i, [r, g, b(, a)])` (linear, multiplies the base colour like a vertex colour), `setUVTransformAt(i, {offset, scale})` (applied to both UV sets before the material's texture transforms, e.g. a `packAtlas` region; no rotation), `count`, `needsUpdate`, `dispose()` (frees the GPU buffer; it is recreated on the next draw). Setters upload only the changed rows on the next frame. Shadows and `@margoengine/staging` contact shadows cast every instance; clustered, IBL, fog and SSAO apply through the same lighting hooks (the instanced shader changes only the vertex stage); `model.bounds` covers every instance; bvh's `Raycaster` and selection's `Picking` report `instanceId`, and a selected model outlines every instance. A mirrored instance (negative determinant) turns off face culling for that primitive and discards back faces in the shader instead. The non-instanced draw makes the same GPU calls as before (`gltf-pro-lighting-hooks.proof.js`, `materials-uv-transform.proof.js` against the previous commit).

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

The result equals `loadGLTF` / `parseGLTFAsync` byte for byte (`tests/worker.test.js` compares document, buffers, every accessor, packed vertices, materials, images and node transforms). The functions run on the calling thread instead when `Worker` is unavailable (SSR, Node) or `decoders` are passed (Draco and KTX2 already decode in their own workers). The worker script, `dist/workers/gltf.js` (5.5 kB gzip), is started with `new URL('./workers/gltf.js', import.meta.url)`, which Vite and webpack copy as an asset: apps that do not import `/worker` ship none of it. One worker per load, terminated afterwards. `modelFromPrepared(engine, prepared)` and `@margoengine/gltf-pro/prepare` (`prepareGLTF`, `prepareAsset`) let other loaders' workers (fbx, usdz) reuse the step. Main-thread blocking measured in a real browser: `examples/package-benchmarks/workers/` (HANDOFF 1f.j).

## Extensions and compressed files

Supported glTF extensions: `KHR_mesh_quantization`, `KHR_texture_transform`, `KHR_materials_emissive_strength`, `KHR_materials_unlit`, `KHR_lights_punctual`, `KHR_materials_clearcoat`, `KHR_materials_transmission`, `KHR_materials_ior`, `KHR_materials_volume`, `KHR_materials_sheen`, `KHR_materials_specular`, `EXT_texture_webp`, `EXT_texture_avif`, `EXT_mesh_gpu_instancing` (`TRANSLATION`, `ROTATION` including normalized integers, `SCALE`; the node's primitives get one `PBRInstances`, see "Instancing"), plus `KHR_draco_mesh_compression`, `EXT_meshopt_compression` (and `KHR_meshopt_compression`) and `KHR_texture_basisu` when you pass the matching decoder. A file is rejected only when its `extensionsRequired` lists something still unsupported; the error names each one and the decoder it needs.

This package does not import `@margoengine/decoders`. Pass decoders in, so files without compression pay nothing:

```ts
import {loadGLTF, parseGLTFAsync} from '@margoengine/gltf-pro';
import {DracoDecoder, KTX2Decoder, MeshoptDecoder} from '@margoengine/decoders';

const decoders = {draco: new DracoDecoder(), meshopt: MeshoptDecoder, ktx2: new KTX2Decoder({device: stage.engine.gpu})};
const model = await loadGLTF(stage.engine, '/gltfpack-output.glb', {decoders});
const dropped = await parseGLTFAsync(stage.engine, await file.arrayBuffer(), {decoders}); // in-memory GLB/JSON
// decoders.draco.dispose(); decoders.ktx2.dispose(); when no more loads are expected.
```

Any object with the same shape works (`GLTFDecoderHooks`): `draco.decode(bytes, {attributeIds, componentTypes, signal})` resolving to `{positions, normals?, uvs?, colors?, indices?, attributes?}`, `meshopt.decodeGltfBuffer(target, count, stride, source, mode, filter)` (three.js's `MeshoptDecoder` fits once its `ready` promise resolves), and `ktx2.transcode(bytes, {signal})` resolving to `{width, height, format, mipmaps: [{data, width, height}]}` in rgba8, BC7, ASTC 4x4 or ETC2 RGBA8. The synchronous `parseGLTF` keeps its signature and takes no decoders. Without a ktx2 decoder, KTX2 images are skipped and a texture's PNG/JPEG fallback `source` is used.

`model.lights` and `model.cameras` expose `KHR_lights_punctual` lights and glTF cameras as data, each with its scene `node`. `model.clusteredLights()` returns the point and spot lights in world space for `clustered.setLights(...)`; an unbounded light gets the range where intensity/d² falls to 1/256. Directional lights are left to the engine's own light.

Materials using clearcoat, transmission, IOR, volume, sheen or specular compile a separate shader variant with eight more texture slots (clearcoat, clearcoat roughness, clearcoat normal, transmission, sheen color, sheen roughness, specular, specular color), so plain materials keep the original shader and bindings. Approximations, by design:

- Transmission does not refract. A transmissive surface draws in the blended queue with its diffuse reduced by the transmission factor and texture, and the background shows through multiplied by one per-material tint: base color × transmission × volume attenuation (`attenuationColor` raised to `thicknessFactor / attenuationDistance`). `transmissionTexture` therefore varies the surface but not the background; `thicknessTexture` is ignored.
- Sheen (Charlie distribution) and clearcoat (GGX on its own normal, F0 0.04) respond to the key light and the hemisphere fill. Image-based lighting patches and clustered lights light the base layer only.
- IOR and `KHR_materials_specular` set the dielectric F0 as three.js does: `min(((ior-1)/(ior+1))² × specularColor, 1) × specular`.

Limits: triangles only; four skin influences in the animation package; texture coordinate sets beyond 1 are rejected. Ambient fill uses fixed sky/ground colors unless `@margoengine/environment`'s `EnvironmentLighting` is applied to the model (`ibl.applyTo(model)`), which adds image-based lighting. Bounds describe the original mesh. Core `engine.pick` returns models only when `@margoengine/selection`'s `Picking` is attached; bvh's `Raycaster` hits them on the CPU.

The demo at `/examples/damaged-helmet.html` downloads the [Khronos Damaged Helmet](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DamagedHelmet). Its credits/licenses remain with the original asset.
