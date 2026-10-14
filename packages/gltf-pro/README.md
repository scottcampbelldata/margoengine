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

Attach animation with the separate animation package. Register this model with `ssao.add(model)` to include its mapped normals and ambient lighting in SSAO. When a lighting effect names the ambient light `let margoAmbient=` (environment's `EnvironmentLighting`), the SSAO ambient replay draws the lit fragment returning `margoAmbient` (zero for unlit materials) with the effects' group-2 bindings; otherwise it draws `ambientFragment` as before. Neither extension is imported by this package. Disposal and device restoration retain CPU asset blueprints.

Register with `shadows.add(model)` and `clustered.add(model)` for optional directional shadows and local PBR lights, including the current skinned vertex buffer. `addLighting()` accepts an optional shader/binding hook without importing these packages. `shadowPrimitives` exposes current opaque/masked GPU geometry to depth consumers; blended materials are omitted.

Pipeline state hook: set `primitive.material.renderState` (type `PBRRenderState`) to override the beauty pipeline's
`blend` (a `GPUBlendState`, or `null` for no blending), `depthWrite` and `depthCompare` for every primitive using that
material; unset fields keep the defaults above. It is part of the pipeline cache key (replace the object rather than
mutating it), the g-buffer and ambient passes ignore it, and draw order and pass splitting still follow `alphaMode`.
Without it the pipelines are unchanged. `@margoengine/materials` uses it for `blending`, `depthWrite` and `depthTest`.

## Extensions and compressed files

Supported glTF extensions: `KHR_mesh_quantization`, `KHR_texture_transform`, `KHR_materials_emissive_strength`, `KHR_materials_unlit`, `KHR_lights_punctual`, `KHR_materials_clearcoat`, `KHR_materials_transmission`, `KHR_materials_ior`, `KHR_materials_volume`, `KHR_materials_sheen`, `KHR_materials_specular`, `EXT_texture_webp`, `EXT_texture_avif`, plus `KHR_draco_mesh_compression`, `EXT_meshopt_compression` (and `KHR_meshopt_compression`) and `KHR_texture_basisu` when you pass the matching decoder. A file is rejected only when its `extensionsRequired` lists something still unsupported; the error names each one and the decoder it needs.

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

Limits: triangles only; four skin influences in the animation package; texture coordinate sets beyond 1 are rejected. Ambient fill uses fixed sky/ground colors, without image-based lighting. Bounds describe the original mesh; custom rendered models are outside core GPU picking.

The demo at `/examples/damaged-helmet.html` downloads the [Khronos Damaged Helmet](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DamagedHelmet). Its credits/licenses remain with the original asset.
