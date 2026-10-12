# @margoengine/blender

Optional offline Blender `.margo` assets for Margo WebGPU PBR. Core and the stage facade remain unchanged. Geometry is validated and uploaded from views of the original binary buffer without glTF accessor decoding or vertex repacking. Repeated meshes share CPU views and GPU geometry buffers; each object keeps its own transform/material uniforms.

For a published runtime release, install its peer packages too:

```sh
npm install @margoengine/core @margoengine/gltf-pro @margoengine/blender
```

Workspace runtime packages remain at `0.1.0`; this change packages the Blender add-on as `1.0.0` and does not publish npm packages.

```ts
import {Engine} from '@margoengine/core';
import {loadMargo,parseMargo,decodeMargo} from '@margoengine/blender';
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend:'webgpu',capacity:4096});
const model = await loadMargo(engine, '/scene.margo');
const b = model.bounds;
engine.camera.fitToBoundingBox([b[0],b[1],b[2]], [b[3],b[4],b[5]], {duration:0});
engine.start();
// Local file: await parseMargo(engine, await file.arrayBuffer()).
// Inspection without GPU: decodeMargo(bytes).
// model.destroy() unloads the scene; engine.dispose() releases all plugins.
void parseMargo; void decodeMargo;
```

`decodeMargo(bytes)` is synchronous and returns the scene/material document, validated geometry, and embedded PNG bytes. CAD meshes without UVs, tangents or vertex colors use 24 bytes per vertex on disk and expand once to the renderer's 80-byte PBR layout; PBR vertices and uint32 indices retain input buffer views; uint16 indices expand once to uint32. `parseMargo(engine, bytes, {signal})` decodes images and attaches the existing glTF Pro `PBRModel`; `loadMargo(engine, url, {signal})` also downloads with the shared bounded reader. Rendering requires WebGPU. Inputs must have a four-byte-aligned byte offset in an ordinary `ArrayBuffer`; SharedArrayBuffer is rejected. Retain and do not mutate/transfer the input while the asset/model is alive. Device restoration reuses the retained CPU geometry and images. Loading creates scene handles and GPU resources, and GPU uploads copy bytes.

The returned model supports the existing shadows/SSAO/clustered-light hooks. Imported custom properties are available at `model.asset.doc.nodes[i].extras.margo.properties`; they do not automatically enable physics, ECS, particles or scatter. Blender asset IDs are metadata, separate from engine slot IDs. Core GPU picking does not include custom PBR models.

## Blender installation and export

Run `npm run package:blender` from the repository root (Python 3.11+). This creates `dist/margo-blender-addon-v1.0.0.zip` with the extension manifest, legacy `bl_info`, exporter, binary writer and MIT license. Packaging uses an explicit file list, excluding caches, tests and scratch files.

1. Download or build `margo-blender-addon-v1.0.0.zip`.
2. Open Blender → **Edit → Preferences → Get Extensions** (or **Add-ons**).
3. Open the top-right chevron menu → **Install from Disk…** and select the ZIP.
4. Enable **Margo Engine Exporter** if it is not enabled automatically.
5. Use **File → Export → Margo (.margo)**.

The declared minimum is Blender 4.2; installation/export are exercised in Blender 5.3 Beta. Blender 4.0/4.1 are outside this range. The single folder inside the ZIP follows Blender's [extension archive layout](https://docs.blender.org/manual/en/4.2/advanced/extensions/getting_started.html) and also preserves legacy add-on discovery. Open exported assets with `/examples/blender-loader/index.html` using `npm run modern:dev:extensions`.

With the existing stage facade (available locally as `margoengine`), load into its engine and let its render loop draw the attached model:

```ts
import {createStage} from 'margoengine';
import {loadMargo} from '@margoengine/blender';
const stage = await createStage('#scene', {backend:'webgpu',capacity:4096});
const model = await loadMargo(stage.engine, '/assets/machine_cell.margo');
const b = model.bounds;
stage.engine.camera.fitToBoundingBox([b[0],b[1],b[2]], [b[3],b[4],b[5]], {duration:0});
window.addEventListener('pagehide', () => stage.dispose(), {once:true});
```

`loadMargo` attaches the existing glTF Pro model plugin directly. `stage.dispose()` releases every imported GPU buffer/texture and decoded image; call it on application unmount. Use `model.destroy()` to unload an asset earlier. Loading/uploading and the existing PBR render loop allocate memory; zero steady-state heap churn has not been established.

The exporter uses Blender native bulk reads and bundled NumPy, with Python 3.11+ compatible code, to handle visible evaluated meshes, modifiers and mesh instances in Y-up meters. Parent transforms are flattened into world TRS. Negative scale is preserved; shear and singular transforms fail with an instruction to apply transforms. UV seams, corner normals and tangents are split correctly. Identical geometry/material combinations share a mesh record. Object names/library identity and instance paths determine repeatable asset IDs; renaming objects changes IDs. `margo:` scalar properties and numeric arrays up to 32 values are retained.

Supported materials: direct Principled BSDF; constant metallic/roughness; constant or direct sRGB image base color and emission; tangent-space Non-Color normal maps; constant alpha or the base image's alpha; active UV map; repeat/clamp wrapping and linear/nearest filtering. Embedded images use RGBA8 PNG. Each image is limited to 4096 × 4096, all decoded images to 256 MiB, the file to 256 MiB, and the manifest to 1 MiB. Export writes atomically, so a failed export preserves an existing asset.

Unsupported inputs fail by material/object name: procedural node graphs, textured metallic/roughness, transmission, variable IOR, coat, sheen, subsurface, HDR textures/emission, custom texture mappings, and animation. Geometry Nodes mesh outputs/mesh instances are evaluated; curves, points and volumes must be converted to meshes first. Node graph baking, live link, skeletal animation and automatic gameplay registration are subsequent milestones. Emission stays separate from optional tone mapping.

## Verification

After `npm run build:packages`:

```sh
npm test --workspace @margoengine/blender
python tools/blender-addon/tests/test_format.py
python tools/blender-addon/tests/test_package.py
npm run package:blender
npm run modern:test:blender
npm run modern:test:interop:packages
npm run measure:size
```

Set `MARGO_BLENDER` to a Blender executable when running `modern:test:blender` to install/enable/export/disable the packaged ZIP in a disposable background profile, then generate and check real exporter fixtures. Without it, CI checks the Python-written fixture, rendered textured pixels, shared GPU geometry, shadow/SSAO compatibility, device restoration and rollback. The Python tests also verify the checked-in fixture matches the writer. The package is optional and decode-only imports discard the PBR renderer.

The package checks compile packed consumers and the first README example under strict NodeNext and Bundler resolution. Isolation tests build both core-only and core + stage entries without Blender/PBR modules. Browser tests track every buffer created by `loadMargo` and require exactly one `destroy()` per buffer when the stage unmounts.

Validate the archive with an installed Blender executable: `blender --factory-startup --command extension validate dist/margo-blender-addon-v1.0.0.zip`.

The binary contract is documented in [FORMAT.md](FORMAT.md). MIT licensed.
