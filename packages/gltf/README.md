# @margoengine/gltf

Import `margoengine/gltf` from the `margoengine` package, or `@margoengine/gltf` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Lazy static glTF/GLB loading, named nodes and shared primitive geometry for Margo Engine.

Package name: `@margoengine/gltf`, version `1.0.0`. Build from source or install a local tarball until the renamed package is published.

```sh
npm install @margoengine/core@1.0.0 @margoengine/gltf@1.0.0
```

```ts
import { Engine } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/model.glb');
engine.start();
// On teardown: model.dispose(); engine.dispose();
```

## Optional features

The root loader reads static models with float positions and constant colours. Each feature below is its own entry, so
a file that needs none of them costs none of their bytes. Pass the ones you want in `extensions`, to `loadGLTF` or
`parseGLTF`; they combine. A file needing something no entry covers still throws, with a pointer to `@margoengine/gltf-pro`.

### Quantized meshes

`@margoengine/gltf/quantized` reads `KHR_mesh_quantization`: integer POSITION (signed or unsigned, 8 or 16 bit,
normalized or not) and normalized signed 8 or 16 bit NORMAL. Optimizers such as gltfpack write these. Values turn into
floats on load, so the file is smaller on the wire and the same size on the GPU.

```ts
import { Engine } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf';
import { quantized } from 'margoengine/gltf/quantized';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/packed.glb', { extensions: [quantized] });
engine.start();
// On teardown: model.dispose(); engine.dispose();
```

### Base colour maps and cut-outs

`@margoengine/gltf/textured` draws `baseColorTexture` and `alphaMode: 'MASK'`, so a prop with one texture stays on the
light path. It reads any `TEXCOORD_n` set, in float or normalized form, applies `KHR_texture_transform`, multiplies by
`baseColorFactor` and cuts at `alphaCutoff` (default 0.5). PNG and JPEG images come from the GLB, a data URI or a URL
next to the file. Other maps, `BLEND`, and compressed or WebP textures still need `@margoengine/gltf-pro`.

```ts
import { Engine } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf';
import { textured } from 'margoengine/gltf/textured';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/prop.glb', { extensions: [textured] });
engine.start();
// On teardown: model.dispose(); engine.dispose();
```

Images decode asynchronously, so for bytes already in memory use `parseGLTFAsync(engine, bytes, [], { extensions })` in
place of `parseGLTF`. WebGPU only: a WebGL engine refuses the file. The meshes stay core meshes, so they move, pick and
dispose as usual, and packages that patch core's shader apply to them. A cut-out casts its outline through
`@margoengine/shadows`, and `engine.stats.drawCalls` counts these draws. GPU picks see a cut-out as solid, because core's
pick draw has no uv; for a ray that passes through the holes, `texturedAlphaMasks(model, {signal, pixels})` gives
`AlphaRaycaster` its masks. Call it before `model.dispose()`; it reads each image once through an `OffscreenCanvas`, so in
Node pass `pixels`.

```ts
import { Engine } from 'margoengine/core';
import { AlphaRaycaster } from 'margoengine/bvh/alpha';
import { loadGLTF } from 'margoengine/gltf';
import { textured, texturedAlphaMasks } from 'margoengine/gltf/textured';

const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadGLTF(engine, '/fence.glb', { extensions: [textured] });
const ray = new AlphaRaycaster();
ray.alphaMask = await texturedAlphaMasks(model);
ray.firstHitOnly = true; // the nearest solid hit
ray.setFromEngine(engine, 320, 240);
console.log(ray.intersectEngine(engine)[0]?.mesh);
```

### Meshopt compression

`@margoengine/gltf/meshopt` reads `EXT_meshopt_compression` and `KHR_meshopt_compression`, every mode and filter.
`@margoengine/decoders/meshopt` is imported on the first file that uses them, so install `@margoengine/decoders` beside
this package; a file with no compressed views never loads it. A fallback buffer is not downloaded. Optimizers usually
quantize as well, so pass both.

```ts
import { Engine } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf';
import { meshopt } from 'margoengine/gltf/meshopt';
import { quantized } from 'margoengine/gltf/quantized';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/small.glb', { extensions: [meshopt, quantized] });
engine.start();
// On teardown: model.dispose(); engine.dispose();
```

Decoded data may reach 64 MiB per file. For bytes in memory use `parseGLTFAsync`.

### GPU instancing

`@margoengine/gltf/instancing` reads `EXT_mesh_gpu_instancing`, for forests and repeated props. Each instance becomes a
child node of the instanced node, on the shared mesh, and core draws all of them as one instanced draw per primitive.
TRANSLATION, ROTATION and SCALE are read in float or quantized form; other instance attributes are ignored.

```ts
import { Engine } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf';
import { instancing } from 'margoengine/gltf/instancing';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/forest.glb', { extensions: [instancing], maxNodes: 500_000 });
engine.start();
// On teardown: model.dispose(); engine.dispose();
```

An instance costs one core mesh plus one per primitive, shows up in `model.nodes` and `model.meshes`, can be moved like
any node, and counts toward `maxNodes` (default 100,000).

### Any file, without choosing a loader

`loadAuto` from `@margoengine/gltf/auto` reads the file, runs the light loader with only the entries that file calls for,
and imports `@margoengine/gltf-pro` only if the light loader refuses it as unsupported, or the file passes a limit only
the light loader has: one million vertices in total, one million values in an accessor, or instances past `maxNodes`.
Each URL is downloaded once, whichever loader runs. A malformed file is an error either way, and so is a file over a limit
both loaders share: 64 MiB, or more real nodes than `maxNodes`. Install `@margoengine/gltf-pro` beside this package for
files that need it; without it such a file rejects with a message that says so. It also takes `signal`, `fetch`,
`maxNodes` and `allowedURLs`.

```ts
import { Engine } from 'margoengine/core';
import { loadAuto } from 'margoengine/gltf/auto';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const { model, loader } = await loadAuto(engine, '/any.glb');
console.log(`Loaded by ${loader}`);
engine.start();
// On teardown: model.dispose(); engine.dispose();
```

`model` is a light `Model` or a `PBRModel`; `loader` tells them apart, and with `'gltf-pro'` the result also holds the
`reason` the light loader gave.

### Cameras and lights as data

`@margoengine/gltf/scene-data` accepts nodes with a glTF camera or a `KHR_lights_punctual` light, and hands them back as
plain data, so a scene file can set up its own view and sun. Nothing is created in the engine: the app decides what to do
with them. `loadAuto` adds the entry for you, and `sceneData` reads its result too.

```ts
import { Engine } from 'margoengine/core';
import { loadGLTF } from 'margoengine/gltf';
import { sceneData, sceneExtras } from 'margoengine/gltf/scene-data';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/shot.glb', { extensions: [sceneExtras] });
const { cameras, lights } = sceneData(model);
const view = cameras[0];
if (view) console.log(view.position, view.direction, view.type === 'perspective' ? view.yfov : view.ymag);
for (const light of lights) console.log(light.type, light.color, light.intensity);
engine.start();
// On teardown: model.dispose(); engine.dispose();
```

Each entry holds the node's `name`, its `node` handle, and its world `position`, `direction` and `matrix` at load with the
model at its origin; the projection or light values follow glTF's names and units, with the defaults filled in. Only
nodes of the loaded scene count. A file still needs a mesh: one with only cameras and lights is refused.

This ESM package includes TypeScript declarations and requires `@margoengine/core` 1.0.0. See the supported glTF subset and lifecycle guide before importing assets.

Apache-2.0 licensed.

### Git LFS pointer files

A repository cloned without Git LFS serves small pointer files (text starting `version https://git-lfs`) in place of
its models. `loadGLTF` and `loadAuto` check every .gltf, .glb, external .bin and image they fetch, and `parseGLTF`
the bytes or text it is given; a pointer rejects with a `MargoError` (code `failed`) that names the URL and links to
https://margoengine.com/errors#git-lfs. Run `git lfs pull` where the files are served, then reload.

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.

The textured pass uses the same CPU-normalized light direction as constant
materials. Direction magnitude does not change the lighting; its fourth
component still controls intensity.
