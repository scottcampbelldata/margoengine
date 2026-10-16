# Margo Engine glTF Pro

Use `import {GLTFAsset} from '@margoengine/gltf-pro/asset'` for accessor decoding
without loading PBR rendering or its shaders. The root export retains the same
constructor; `GLTFDocument` is available as a type from either entry.

Optional WebGPU glTF 2.0 metallic-roughness rendering, separate from the frozen core and stage. The public npm name follows this repository's scope: `@margoengine/gltf-pro`.

The verified core + stage bundle remains **19,999 bytes gzip**; CI rejects 20,000 bytes and above. Optional loaders, decoder code, workers and Wasm stay outside that measurement.

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

`loadGLTF` automatically decodes `KHR_draco_mesh_compression` primitives and
`EXT_meshopt_compression` buffer views using `@margoengine/decoders`, installed as
a dependency. Draco workers and Wasm start only when compressed primitives are
encountered and are released after decoding, including on failure or cancellation.
Meshopt decoding is synchronous and cached per buffer view, including views used
by skin, morph and animation accessors. Unknown required extensions still fail.

For in-memory JSON or GLB bytes, use
`await parseGLTFAsync(engine, input, buffers, images, {signal, draco})`.
The existing `parseGLTF(engine, input, buffers, images)` remains synchronous for
uncompressed and meshopt assets; Draco input directs callers to the async API.
Both async APIs accept `{signal}` and an optional reusable `draco` decoder with a
`decode` method. A supplied decoder stays owned by its caller. The default Draco
decoder requires browser module workers; server callers can supply a decoder.
Draco attributes and indices populate the original accessors, preserving skin and
morph data and leaving attributes outside the compression map on the usual path.
Normalized integer UVs, colors and extra channels are converted once according to
their accessor metadata; decoding leaves the caller's glTF document unchanged.

The loader passes declared vertex/index counts, accessor widths and the remaining
256 MiB decoded-data budget into Draco. The default decoder rejects oversized
actual geometry before allocating output arrays, including topology without an
index accessor. It still needs to decode internal Wasm geometry before reading
those counts. Custom `draco.decode` hooks should honor the supplied `limits`;
the loader also validates returned data before constructing GPU resources.

`parsePreparedPBR(engine, document, geometry, images)` accepts a static glTF-style scene/material document and per-mesh arrays of `PreparedGeometry` (`vertices: Float32Array`, `indices: Uint32Array`). Vertices use the existing 80-byte layout: position4, normal4, tangent4, UV0+UV1, color4. Arrays are validated and retained without repacking; keep them immutable until destruction. This path has no accessors, skins or animations and is used by the separate `@margoengine/blender` loader. Existing glTF loading and animation APIs are unchanged.

Attach animation with the separate animation package. Register this model with `ssao.add(model)` to include its mapped normals and ambient lighting in SSAO. Neither extension is imported by this package. Disposal and device restoration retain CPU asset blueprints.

Register with `shadows.add(model)` and `clustered.add(model)` for optional directional shadows and local PBR lights, including the current skinned vertex buffer. `addLighting()` accepts an optional shader/binding hook without importing these packages. `shadowPrimitives` exposes current opaque/masked GPU geometry to depth consumers; blended materials are omitted.

Limits: triangle primitives; four skin influences in the animation package; KTX2 textures, texture transforms, additional UV sets and other required extensions are rejected or require a future extension. Ambient fill uses fixed sky/ground colors, without image-based lighting. Bounds describe the original mesh; custom rendered models are outside core GPU picking.

The demo at `/examples/damaged-helmet.html` downloads the [Khronos Damaged Helmet](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DamagedHelmet). Its credits/licenses remain with the original asset.
