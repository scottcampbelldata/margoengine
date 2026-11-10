# @margoengine/blender

Import `margoengine/blender` from the `margoengine` package, or `@margoengine/blender` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional offline Blender `.margo` assets for Margo WebGPU PBR. Core and the stage facade remain unchanged. Geometry is validated and uploaded from views of the original binary buffer without glTF accessor decoding or vertex repacking. Repeated meshes share CPU views and GPU geometry buffers; each object keeps its own transform/material uniforms.

File size: a mesh with a UV set or colours is stored at 80 bytes per vertex, the layout the GPU draws from, so a `.margo` file is larger than Blender's glTF of the same scene (11,227,568 B against 4,959,600 B for a 256 x 128 sphere, [measured](../../docs/whitepaper/batch-170-blender.md)). `compressMargoMeshopt` from `@margoengine/blender/meshopt` shrinks it (3,386,244 B there); a compact export layout is planned.

Nothing is on npm yet. Once the runtime packages are published, install the peer packages too:

```sh
npm install @margoengine/core @margoengine/gltf-pro @margoengine/blender
```

Workspace runtime packages remain at `0.1.0`; this change packages the Blender add-on as `1.0.0` and does not publish npm packages.

```ts
import {Engine} from 'margoengine/core';
import {loadMargo,parseMargo,decodeMargo} from 'margoengine/blender';
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend:'webgpu',capacity:4096});
const model = await loadMargo(engine, '/triangle.margo'); // a test scene in tests/fixtures
const b = model.bounds;
engine.camera.fitToBoundingBox([b[0],b[1],b[2]], [b[3],b[4],b[5]], {duration:0});
engine.start();
// Local file: await parseMargo(engine, await file.arrayBuffer()).
// Inspection without GPU: decodeMargo(bytes).
// model.dispose() unloads the scene; engine.dispose() releases all plugins.
void parseMargo; void decodeMargo;
```

`decodeMargo(bytes)` is synchronous and returns the scene/material document, validated geometry, and embedded PNG bytes. Compact meshes (no UVs, tangents or vertex colors) use 24 bytes per vertex on disk and expand once to the renderer's 80-byte PBR layout; PBR vertices and uint32 indices retain input buffer views; uint16 indices expand once to uint32. `parseMargo(engine, bytes, {signal})` decodes images and attaches the existing glTF Pro `PBRModel`; `loadMargo(engine, url, {signal})` also downloads with the shared bounded reader. Rendering requires WebGPU. Inputs must have a four-byte-aligned byte offset in an ordinary `ArrayBuffer`; SharedArrayBuffer is rejected. Retain and do not mutate/transfer the input while the asset/model is alive. Device restoration reuses the retained CPU geometry and images. Loading creates scene handles and GPU resources, and GPU uploads copy bytes.

The returned model supports the existing shadows/SSAO/clustered-light hooks. Imported custom properties are available at `model.asset.doc.nodes[i].extras.margo.properties`; the `components` entry (below) turns the component tags among them into colliders, bodies, lights and scripts, and the plain loaders leave them as data. Blender asset IDs are metadata, separate from engine slot IDs. Core GPU picking does not include custom PBR models.

## Blender installation and export

Run `npm run package:blender` from the repository root (Python 3.11+). This creates `dist/margo-blender-addon-v1.0.0.zip` with the extension manifest, legacy `bl_info`, exporter, binary writer and Apache-2.0 license. Packaging uses an explicit file list, excluding caches, tests and scratch files.

1. Download or build `margo-blender-addon-v1.0.0.zip`.
2. Open Blender → **Edit → Preferences → Get Extensions** (or **Add-ons**).
3. Open the top-right chevron menu → **Install from Disk…** and select the ZIP.
4. Enable **Margo Engine Exporter** if it is not enabled automatically.
5. Use **File → Export → Margo (.margo)**.

The declared minimum is Blender 4.2; installation/export were developed against Blender 5.3 Beta and are exercised only when `MARGO_BLENDER` points at a Blender executable (run on Blender 5.3 Beta, 2026-11-06, claim LIM-287; not in the checks). Blender 4.0/4.1 are outside this range. The single folder inside the ZIP follows Blender's [extension archive layout](https://docs.blender.org/manual/en/4.2/advanced/extensions/getting_started.html) and also preserves legacy add-on discovery. Open exported assets with `/examples/blender-loader/index.html` using `npm run modern:dev:extensions`.

With the existing stage facade (available locally as `margoengine`), load into its engine and let its render loop draw the attached model:

```ts
import {createStage} from 'margoengine';
import {loadMargo} from 'margoengine/blender';
const stage = await createStage('#scene', {backend:'webgpu',capacity:4096});
const model = await loadMargo(stage.engine, '/mixed-triangle.margo'); // a test scene in tests/fixtures
const b = model.bounds;
stage.engine.camera.fitToBoundingBox([b[0],b[1],b[2]], [b[3],b[4],b[5]], {duration:0});
window.addEventListener('pagehide', () => stage.dispose(), {once:true});
```

`loadMargo` attaches the existing glTF Pro model plugin directly. `stage.dispose()` releases every imported GPU buffer/texture and decoded image; call it on application unmount. Use `model.dispose()` to unload an asset earlier. Loading/uploading and the existing PBR render loop allocate memory; zero steady-state heap churn has not been established.

The exporter uses Blender native bulk reads and bundled NumPy, with Python 3.11+ compatible code, to handle visible evaluated meshes, modifiers and mesh instances in Y-up meters. Parent transforms are flattened into world TRS. Negative scale is preserved; shear and singular transforms fail with an instruction to apply transforms. UV seams, corner normals and tangents are split correctly. Identical geometry/material combinations share a mesh record. Object names/library identity and instance paths determine repeatable asset IDs; renaming objects changes IDs. `margo:` scalar properties and numeric arrays up to 32 values are retained.

Supported materials: direct Principled BSDF; constant metallic/roughness; constant or direct sRGB image base color and emission; tangent-space Non-Color normal maps; constant alpha or the base image's alpha; active UV map; repeat/clamp wrapping and linear/nearest filtering. Embedded images use RGBA8 PNG. Each image is limited to 4096 × 4096, all decoded images to 256 MiB, the file to 256 MiB, and the manifest to 1 MiB. Export writes atomically, so a failed export preserves an existing asset.

Any other surface material is baked at export (next section). Transmission, IOR, coat, sheen and subsurface export as glTF material extensions (see Extended Principled inputs). Unsupported inputs fail by material/object name: linked (textured) transmission, IOR, coat, sheen or subsurface, a coat with an IOR other than 1.5, a tint or a normal map, specular and anisotropy other than the defaults, volume and displacement outputs, HDR textures/emission, and any material that needs baking when baking is off. Geometry Nodes mesh outputs/mesh instances are evaluated; curves, points and volumes must be converted to meshes first. Visible lights and cameras export too (Lights and cameras, below). Edits reach a running page through the live link (Live link, below). Emission stays separate from optional tone mapping.

## Node materials: baked at export

A material outside the direct subset above (a procedural node graph, textured metallic or roughness, an image through a custom mapping, or another surface shader such as Diffuse BSDF or a Mix Shader) is baked with Cycles on the CPU when it is exported: each Principled input that is linked (base colour, alpha, metallic, roughness, normal, emission) bakes to an image on the object's active UV map, packed as glTF expects (roughness in green, metallic in blue), and the constants stay factors. Another surface shader bakes Cycles' diffuse colour and roughness passes (and its normal and emission when it has them) and exports as a dielectric. The images are ordinary embedded PNG textures, so the engine needs no extra code or bytes. Baking leaves the scene as it was: render engine, selection, nodes and images.

```python
import bpy

# In Blender's Python console or a script: the File > Export > Margo dialog has the same Bake size option.
bpy.ops.export_scene.margo(filepath="//scene.margo", bake_size=1024)
```

`bake_size` is the side of each baked image in pixels: 16 to 4096, default 1024; `0` turns baking off, so such a material fails by name as before. Each baked material is baked once per mesh that uses it (its UV layout); the mesh needs an active UV map and must be a real object in the view layer. A real Blender 5.2.3 LTS export of a procedural Principled material matches its node maths at every texel within the sampling and rounding bound (LIM-401; `tests/bake.test.js`).

## Extended Principled inputs: transmission, IOR, coat, sheen and subsurface

The exporter writes the Principled BSDF's constant transmission, IOR, coat, sheen and subsurface as glTF material extensions: `KHR_materials_transmission` (Transmission Weight), `KHR_materials_ior` (IOR, when not 1.5), `KHR_materials_clearcoat` (Coat Weight and Coat Roughness), `KHR_materials_sheen` (Sheen Tint times Sheen Weight, Sheen Roughness), and for subsurface `KHR_materials_diffuse_transmission` (Subsurface Weight, the base colour) into a scattering volume, `KHR_materials_volume` plus the draft `KHR_materials_volume_scatter`: the base colour is the multiple-scattering albedo and Subsurface Radius times Subsurface Scale each channel's mean free path. `loadMargo` draws such a file with the plain PBR shader, which ignores them; `@margoengine/blender/pbr-ext` loads it with glTF Pro's physical material shader, which draws them:

```ts
import {createStage} from 'margoengine';
import {loadMargoPBR} from 'margoengine/blender/pbr-ext';
const stage = await createStage('#scene', {backend:'webgpu',capacity:4096});
const model = await loadMargoPBR(stage.engine, '/pbr-ext.margo'); // the test scene in tests/fixtures
window.addEventListener('pagehide', () => { model.dispose(); stage.dispose(); }, {once:true});
```

`parseMargoPBR(engine, bytes)` does the same from bytes; `margoMaterialExtensions` lists what the add-on writes. The physical shader's WGSL loads only with this entry. A real Blender 5.2.3 LTS export carries Blender's values (LIM-408; `tests/pbr-ext.test.js`), and on the GPU its glass plane shows the backdrop behind it.

## Live link: edits in Blender reach a running page

Open the **Margo** tab of the 3D Viewport's sidebar (N) and press **Start live link**. The add-on serves the scene on this machine only (`http://127.0.0.1:8765/` by default; the operator `margo.live_link` takes `port`, and `bake_size`, 256 while live) and exports it again after each edit Blender reports (geometry, transforms, materials or properties), at most four times a second. The `live` entry follows it: each version is fetched, attached, and the one before disposed.

```ts
import {Engine} from 'margoengine/core';
import {margoLive} from 'margoengine/blender/live';
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend:'webgpu'});
engine.start();
const stop = new AbortController();
window.addEventListener('pagehide', () => stop.abort(), {once:true});
for await (const model of margoLive(engine, 'http://127.0.0.1:8765/', {signal: stop.signal})) {
  const b = model.bounds; // the version Blender holds now; the previous one is already disposed
  engine.camera.fitToBoundingBox([b[0],b[1],b[2]], [b[3],b[4],b[5]], {duration:0});
}
```

Edits that arrive while a version loads are coalesced, so only the newest is fetched. Ending the loop (break, `signal`, an error) disposes the last model. Pass `parse: parseMargoPBR` from `margoengine/blender/pbr-ext` for transmission, coat, sheen and subsurface. While Blender is closed the page keeps the last model and the browser reconnects; a version that fails to export leaves the page on the last good one and the panel shows why. The server binds 127.0.0.1 and answers only pages served from this machine (`localhost`, `127.0.0.1`, `[::1]` or a `.localhost` name), so a web site in another tab cannot read the scene. With a real Blender 5.2.3 LTS session the page draws the red plane Blender serves, and the same loop draws it blue after Blender's material edit, with the first version disposed (LIM-410; `tests/live.test.js`, `tools/blender-addon/tests/test_live.py`).

## Lights and cameras

The exporter writes each visible point, spot and sun light and each camera as a node (the dialog's **Lights and cameras** option, `lights_cameras=True` by default; `False` leaves them out). The node carries the `margo:` tags of the Components table, which the add-on writes itself: a light's colour, its intensity (a point or spot light's power in W times 683 lm/W over 4 pi steradians, in candela; a sun's strength in W/m2 times 683, in lux), Custom Distance as its range, and for a spot half its Spot Size as the outer cone and that times one minus Spot Blend as the inner cone. A camera gets `margo:camera` (`perspective` or `orthographic`), its vertical field of view (`margo:yfov`, radians) or half height (`margo:ymag`), the render's aspect ratio (`margo:aspect`), its clip distances (`margo:znear`, `margo:zfar`) and, for the scene's camera, `margo:active`. The `components` entry builds the lights and cameras and opens the scene through the active camera:

```ts
import {Engine} from 'margoengine/core';
import {loadMargoComponents} from 'margoengine/blender/components';
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend:'webgpu'});
// The test scene in tests/fixtures: a sun, a spot, a point light and two cameras.
// exposure 1/683 undoes the lumens per watt, so the sun lights the engine at Blender's strength.
const scene = await loadMargoComponents(engine, '/scene.margo', {exposure: 1 / 683});
console.log(scene.model.cameras.length, scene.model.lights.map((l) => l.type));
engine.start();
```

`view: false` keeps the engine's camera; `viewGLTFCamera(scene.model, scene.model.cameras[i])` from `margoengine/gltf-pro` switches to another. Point and spot lights light the scene through `@margoengine/clustered` (pass `clustered`); without it only the first sun lights it. A real Blender 5.2.3 LTS export points every light and camera where Blender does (to 1e-6) and projects as Blender's `calc_matrix_camera` does, and on the GPU the page opens on Blender's framing with the sun at Blender's strength (LIM-417; `tests/scene.test.js`). Area lights, panoramic cameras and lens shift fail by object name, as does a custom property the exporter writes itself.

## Curves, points and volumes (`margoengine/blender/curves`)

With the dialog's **Curves, points and volumes** option on (`export_scene(..., curves=True)`, off by default), the exporter writes each visible curves object as splines (legacy Bezier, poly and NURBS curves, hair curves and curves made by geometry nodes, read from the evaluated geometry with their radius, tilt, handles and weights), each point cloud as points with its radii and first colour attribute, and each volume as the OpenVDB file of its grids, with no conversion to meshes. Such a file needs this entry; `loadMargo` refuses it by name. The meshes in it draw as `loadMargo` draws them, and the shapes come back as data for the line, point and volume packages. `evaluateSpline` gives the polyline Blender draws at the spline's resolution:

```ts
import {Engine} from 'margoengine/core';
import {loadMargoCurves, evaluateSpline} from 'margoengine/blender/curves';
import {Lines, Line} from 'margoengine/lines';
import {parseVDB} from 'margoengine/loaders/vdb';
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
// The test scene in tests/fixtures: Bezier, poly, NURBS and hair curves, a point cloud and a smoke volume.
const scene = await loadMargoCurves(engine, '/curves.margo');
const lines = new Lines();
engine.use(lines);
const place = (m: Float32Array, xyz: Float32Array) =>
  Array.from(xyz, (_, i) => m[i % 3] * xyz[i - (i % 3)] + m[4 + (i % 3)] * xyz[i - (i % 3) + 1] + m[8 + (i % 3)] * xyz[i - (i % 3) + 2] + m[12 + (i % 3)]);
for (const curve of scene.curves)
  for (const spline of curve.splines) {
    if (spline.type === 'nurbs' && spline.cyclic && spline.knots === 'endpoint') continue; // not evaluated yet
    const positions = place(curve.matrix, evaluateSpline(spline));
    if (spline.cyclic) positions.push(...positions.slice(0, 3));
    lines.add(new Line({positions, width: 2}));
  }
const [cloud] = scene.points; // positions, radius and colors for PointCloud from margoengine/points
console.log(cloud.name, cloud.positions.length / 3);
const {grids} = await parseVDB(scene.volumes[0].vdb); // grids[0].dense() for fig.volume in margoengine/sciviz
console.log(grids[0].name, grids[0].activeVoxels);
engine.start();
```

A real Blender 5.2.3 LTS export evaluates to Blender's own Convert to Mesh polylines to 2e-5 m (Bezier with free, aligned, auto and vector handles; poly; Uniform and Endpoint NURBS with weights, open and cyclic; open and cyclic Catmull-Rom hair), keeps the cloud's points, radii and colour, and its volume reads with `parseVDB` voxel for voxel as Blender's bundled openvdb module reads it (LIM-420; `tests/curves.test.js`). `evaluateSpline` refuses NURBS with Bezier knot modes and cyclic NURBS with Endpoint knots by name (their control data is still in the file), a scene with both animation and shapes fails to export by name, and a beveled or extruded curve exports as its spline, not its surface. Volume grids keep Blender's Z-up object space; `matrix` places them.

## Compressed textures: KTX2 in `.margo` (`margoengine/blender/ktx2`)

`compressMargo` re-encodes an exported file's PNG textures as KTX2 with Basis Universal (`@margoengine/exporters/ktx2`, Binomial's encoder in Wasm, in Node or a browser worker), so the file downloads smaller and, on an engine created with the texture-compression features, its textures stay compressed on the GPU; colour slots stay sRGB, normal maps are encoded as normal maps, metallic-roughness and other data as linear. `loadMargoKTX2` transcodes each one on the engine's device with `KTX2Decoder` of `@margoengine/decoders` (pass `ktx2` to reuse one) and draws the scene as `loadMargo` does. The add-on still writes PNG; compress the file after export, here in Node:

```ts
import {readFile, writeFile} from 'node:fs/promises';
import {compressMargo, decodeMargoKTX2} from 'margoengine/blender/ktx2';
const source = await readFile(new URL('./tests/fixtures/bake.margo', import.meta.url));
const compressed = await compressMargo(source); // {mode: 'uastc'} for closer to the PNG, at more bytes
console.log(source.length, '->', compressed.length, decodeMargoKTX2(compressed).document.images?.[0]?.mimeType);
await writeFile('bake-ktx2.margo', compressed);
// In the page, ask for the compressed formats, or the textures upload as RGBA8:
// const engine = await Engine.create(canvas, {features: ['texture-compression-bc', 'texture-compression-astc', 'texture-compression-etc2']});
// const model = await loadMargoKTX2(engine, '/bake-ktx2.margo');
```

On the baked fixture (four 32 x 32 textures from Blender 5.2.3) the file goes from 6,660 to 5,464 bytes with ETC1S and 5,712 with UASTC; UASTC images transcode back within a mean of 0.5 of 255 of the PNG (ETC1S within 5.0). On a Radeon 680M with those features the textures upload as BC7 with their 6 mips, and the gradient plane's frame differs from the PNG file's by a mean of 0.25 of 255 with UASTC and 2.3 with ETC1S (the uniform plane: 0 and 0.43); a file whose two colour images trade places draws them swapped, so the pixels come from the KTX2 data (LIM-428; `tests/ktx2.test.js`, `scripts/modern-blender-tests.js`). Bigger textures gain more; tiny ones can grow. Animated files and files with curves, points or volumes are refused by name; `decodeMargo` refuses a KTX2 file by name.

## Characters: armatures, skins, shape keys and actions

A mesh with an Armature modifier or shape keys exports as an animated `.margo`: the armature's bones become joint nodes, vertex groups of deform bones become up to eight normalised influences per vertex, shape keys become morph targets, and each action (the active one, NLA strips' and the shape keys') becomes a clip sampled at every frame. Load it with the `anim` entry and play it with `@margoengine/animation`:

```ts
import {Engine} from 'margoengine/core';
import {loadAnimatedMargo} from 'margoengine/blender/anim';
import {Animation} from 'margoengine/animation';
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend:'webgpu'});
const hero = await loadAnimatedMargo(engine, '/anim.margo'); // the test rig in tests/fixtures
const animation = Animation.attach(hero);
animation.play('Bend'); // the Blender action's name
animation.setMorph(hero.asset.doc.nodes!.findIndex((n) => n.name === 'Tube'), 0, 0.5); // first shape key at half
engine.start();
```

`parseAnimatedMargo(engine, bytes, {signal})` reads local bytes, and `margoToGLTF(bytes)` gives the glTF 2.0 document over the file's own bytes without a GPU. The static `loadMargo` refuses an animated file and names this entry. Real Blender 5.2.3 output played this way stays within 1.1e-6 m of Blender's own deformed vertices at every frame of three clips (CPU, by glTF rules) and within 1e-4 m on the GPU (claim LIM-389).

The exporter refuses, by object name: other modifiers on an animated mesh (apply them first), envelopes, Preserve Volume or a mask group on the Armature modifier, a vertex without deform-bone weight, more than eight influences, absolute, muted or vertex-group-masked shape keys, and instanced animated meshes. Object-level animation is not exported (bones only); the export is at the scene's current frame for everything else.

## Components: colliders, bodies, lights and scripts from custom properties

Tag an object in Blender (Object Properties, Custom Properties) and the `components` entry builds the component when the scene loads, as Godot's and Unity's import pipelines read tagged objects. The tags become glTF extensions (KHR_implicit_shapes, KHR_physics_rigid_bodies, KHR_lights_punctual) in the decoded document, and glTF Pro's `applyGLTFPhysics` and `applyGLTFLights` build them:

| Tag | Values | Meaning |
| --- | --- | --- |
| `margo:collider` | `box`, `sphere`, `capsule`, `cylinder` | A collider sized from the mesh's own box (the object's scale applies); an off-centre mesh gets a child node at its box's centre for the shape. Capsules and cylinders stand along Blender's Z (the engine's Y). |
| `margo:size` | 3 numbers (box), 1 (sphere radius), 2 (radius, height) | Overrides the size from the mesh, in the mesh's units before scale. |
| `margo:body` | `static`, `dynamic`, `kinematic` | A static collider is the default for a collider without a body; a body without a collider gets a box. |
| `margo:mass` | kg | A dynamic body's mass; without it the mass follows the shape's volume at density 1. |
| `margo:friction`, `margo:restitution` | numbers of at least 0 | The collider's physics material (friction 0.6, restitution 0 by default). |
| `margo:trigger` | `true` | A sensor volume in place of a solid collider: `scene.physics.onTrigger` reports what enters and leaves. |
| `margo:light` | `point`, `spot`, `directional` | A punctual light on the object, pointing down its local -Z (Blender's -Z) with `margo:color` (3 linear numbers), `margo:intensity` (candela, or lux for `directional`; default 1), `margo:range`, and for a spot `margo:inner_cone` and `margo:outer_cone` (radians, default 0 and pi/4). |
| `margo:script` | a name, or names separated by commas | Runs that registered script once for the object, after physics and lights. |

```ts
import {Engine} from 'margoengine/core';
import {loadMargoComponents} from 'margoengine/blender/components';
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend:'webgpu'});
const level = await loadMargoComponents(engine, '/components.margo', { // the test level in tests/fixtures
  scripts: {
    door: ({node, properties}) => { console.log('door', node.name, properties); return () => console.log('closed'); },
    glow: ({node}) => void console.log('glow', node.name),
  },
});
level.physics?.onTrigger(({entered, nodeIndex}) => console.log(entered ? 'in' : 'out', nodeIndex));
engine.start();
// level.dispose() runs the scripts' cleanups, removes the lights and bodies, then the model.
```

`parseMargoComponents(engine, bytes, options)` reads local bytes. `margoComponents(decodeMargo(bytes))` gives the document with the extensions and the scripts it names, without a GPU. Physics loads `@margoengine/physics` only when an object has a collider, body or trigger (pass `physics` to add to an existing world, else one is made on the engine); point and spot lights need `clustered` (a `@margoengine/clustered` instance), and the first directional light becomes the engine's light. A tag that cannot be read (a wrong value, a tag on the wrong kind of object, a misspelt tag such as `margo:colider`) fails by object name, and so does a script name missing from `scripts`, before any GPU work. Other `margo:` properties stay plain data. Static files only: an animated file's tags are not read. On a real Blender 5.2.3 export, the real solver drops a tagged 1 m crate and a 0.5 m ball onto a tagged floor and they rest within 1 cm of where the mechanics put them (claim LIM-396).

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

Set `MARGO_BLENDER` to a Blender executable when running `modern:test:blender` to install/enable/export/disable the packaged ZIP in a disposable background profile, then generate and check real exporter fixtures (including the animated rig of `tools/blender-addon/tests/blender_anim.py`, whose committed output and Blender truth `tests/anim.test.js` checks on every run, and a fresh bake of `tools/blender-addon/tests/blender_bake.py` checked against its node maths). Without it (as in the CI workflow), the run checks the Python-written fixture, rendered textured pixels, shared GPU geometry, shadow/SSAO compatibility, device restoration and rollback. The Python tests also verify the checked-in fixture matches the writer. The package is optional and decode-only imports discard the PBR renderer.

The package checks compile packed consumers and the first README example under strict NodeNext and Bundler resolution. Isolation tests build both core-only and core + stage entries without Blender/PBR modules. Browser tests track every buffer created by `loadMargo` and require exactly one `destroy()` per buffer when the stage unmounts.

Validate the archive with an installed Blender executable: `blender --factory-startup --command extension validate dist/margo-blender-addon-v1.0.0.zip`.

The binary contract is documented in [FORMAT.md](FORMAT.md). Apache-2.0 licensed.
