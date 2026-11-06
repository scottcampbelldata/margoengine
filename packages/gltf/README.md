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
dispose as usual, and packages that patch core's shader apply to them. A cut-out picks and casts shadows as solid.

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

This ESM package includes TypeScript declarations and requires `@margoengine/core` 1.0.0. See the supported glTF subset and lifecycle guide before importing assets.

Apache-2.0 licensed.
